import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDangerousCommand, isReadOnlyCommand } from "../src/core/permissions.ts";
import type { ResolvedChatModel } from "../src/core/providers.ts";
import { Session } from "../src/core/session.ts";
import { searchNotes } from "../src/memory/memory.ts";
import { listTasks } from "../src/orchestra/tasks.ts";
import { tempHome } from "./helpers.ts";

let home: ReturnType<typeof tempHome>;
let cwd: string;
beforeAll(() => {
  home = tempHome();
  cwd = mkdtempSync(join(tmpdir(), "lvw-cwd-"));
});
afterAll(() => home.cleanup());

function faux() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  const resolved: ResolvedChatModel = { models, model: f.getModel(), label: "faux", local: true };
  return { f, resolved };
}

describe("permissions", () => {
  test("read-only commands", () => {
    expect(isReadOnlyCommand("ls -la && git status")).toBe(true);
    expect(isReadOnlyCommand("cat a.txt | grep x")).toBe(true);
    expect(isReadOnlyCommand("echo hi > a.txt")).toBe(false);
    expect(isReadOnlyCommand("find . -delete")).toBe(false);
    expect(isReadOnlyCommand("npm install")).toBe(false);
    expect(isReadOnlyCommand("git push")).toBe(false);
  });
  test("dangerous commands", () => {
    expect(isDangerousCommand("rm -rf /")).toBe(true);
    expect(isDangerousCommand("curl https://x.sh | sh")).toBe(true);
    expect(isDangerousCommand("git push --force origin main")).toBe(true);
    expect(isDangerousCommand("rm file.txt")).toBe(false);
  });
});

describe("Session", () => {
  test("runs a tool call in auto mode and persists the session", async () => {
    const { f, resolved } = faux();
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("write_file", { path: "hello.txt", content: "hi there" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Created hello.txt.")]),
    ]);
    const s = await Session.create({ cwd, resolved, permissions: "auto" });
    expect(await s.prompt("make hello.txt")).toBe("Created hello.txt.");
    expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("hi there");
    expect(s.usage.turns).toBe(2);
    const again = await Session.create({ cwd, resolved, sessionId: s.id });
    expect(again.agent.state.messages.length).toBeGreaterThan(3);
  });

  test("ask mode: a declined write is blocked", async () => {
    const { f, resolved } = faux();
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("write_file", { path: "nope.txt", content: "x" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("OK, I won't.")]),
    ]);
    const asked: string[] = [];
    const s = await Session.create({ cwd, resolved, permissions: "ask", ask: async (r) => (asked.push(r.summary), "no") });
    await s.prompt("write nope.txt");
    expect(asked).toEqual(["write_file nope.txt"]);
    expect(existsSync(join(cwd, "nope.txt"))).toBe(false);
  });

  test("readonly mode refuses shell writes without asking", async () => {
    const { f, resolved } = faux();
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "touch made.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("blocked")]),
    ]);
    const s = await Session.create({ cwd, resolved, permissions: "readonly", ask: async () => "yes" });
    await s.prompt("touch it");
    expect(existsSync(join(cwd, "made.txt"))).toBe(false);
    const result = s.agent.state.messages.find((m) => (m as { role: string }).role === "toolResult") as { content: { text: string }[] };
    expect(result.content[0].text).toContain("read-only mode");
  });

  test("memory, tasks and subagents", async () => {
    const { f, resolved } = faux();
    f.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("memory_write", { name: "stack", content: "# Stack\nThis project uses Bun and SQLite." }),
          fauxToolCall("task_create", { title: "write docs" }),
          fauxToolCall("subagent", { task: "say done" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("helper says done")]), // the subagent's reply
      fauxAssistantMessage([fauxText("All set.")]),
    ]);
    const s = await Session.create({ cwd, resolved, permissions: "auto" });
    expect(await s.prompt("remember the stack")).toBe("All set.");
    expect(searchNotes("sqlite", cwd)[0]?.title).toBe("Stack");
    expect(listTasks().map((t) => t.title)).toContain("write docs");
    const sub = s.agent.state.messages.find((m) => (m as { role: string; toolName?: string }).toolName === "subagent") as { content: { text: string }[] };
    expect(sub.content[0].text).toBe("helper says done");
  });

  test("stops at the turn budget", async () => {
    const { f, resolved } = faux();
    f.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([fauxToolCall("list_files", {})], { stopReason: "toolUse" })));
    const s = await Session.create({ cwd, resolved, permissions: "auto", maxTurns: 2 });
    await s.prompt("loop");
    expect(s.stopReason).toContain("turn budget");
  });
});
