import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.ts";
import { Session, shutdownTools } from "../src/core/session.ts";
import { listPlugins } from "../src/plugins/plugins.ts";
import { hostBackend } from "../src/sandbox/exec.ts";
import { listSkills } from "../src/skills/skills.ts";
import { browserTools } from "../src/tools/browser.ts";
import type { ToolContext } from "../src/tools/tool.ts";
import { tempHome } from "./helpers.ts";

let home: ReturnType<typeof tempHome>;
let cwd: string;
beforeAll(() => {
  home = tempHome();
  cwd = mkdtempSync(join(tmpdir(), "lvw-tools-"));
});
afterAll(async () => {
  await shutdownTools();
  home.cleanup();
});

function faux() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  return { models, model: f.getModel(), label: "faux", local: true };
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((b) => b.text ?? "").join("");

describe("browser", () => {
  test("open, snapshot, click by ref, read the result", async () => {
    const page = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(`<title>Counter</title><button onclick="document.getElementById('n').textContent='clicked'">Press me</button><p id="n">waiting</p>`, {
          headers: { "content-type": "text/html" },
        }),
    });
    const ctx: ToolContext = { cwd, config: structuredClone(DEFAULTS), exec: hostBackend(cwd), sessionId: "browser-test", model: faux(), depth: 0 };
    const tools = Object.fromEntries(browserTools(ctx).map((t) => [t.name, t]));
    try {
      const snap = text(await tools.browser_open.execute("1", { url: `http://127.0.0.1:${page.port}/` }));
      expect(snap).toContain("Title: Counter");
      const ref = /\[(e\d+)\] button "Press me"/.exec(snap)?.[1];
      expect(ref).toBeDefined();
      const after = text(await tools.browser_click.execute("2", { ref }));
      expect(after).toContain("clicked");
    } finally {
      page.stop(true);
    }
  }, 60_000);
});

describe("plugins", () => {
  test("a plugin's tools and skills reach new sessions", async () => {
    const dir = join(home.dir, "plugins", "hello");
    mkdirSync(join(dir, "skills", "greet"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "hello", description: "test plugin" }));
    writeFileSync(
      join(dir, "index.ts"),
      `export function tools() {
        return [{ name: "hello_world", label: "Hello", description: "Say hello", parameters: { type: "object", properties: {} }, risk: "read",
          execute: async () => ({ content: [{ type: "text", text: "hello from a plugin" }], details: undefined }) }];
      }`,
    );
    writeFileSync(join(dir, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Greet people\n---\nSay hi.\n");
    mkdirSync(join(home.dir, "plugins", "broken"));
    writeFileSync(join(home.dir, "plugins", "broken", "plugin.json"), "{ not json");

    expect(listPlugins().map((p) => [p.manifest.name, Boolean(p.error)])).toEqual(expect.arrayContaining([["hello", false], ["broken", true]]));
    expect(listSkills(cwd).map((s) => s.name)).toContain("greet");
    const s = await Session.create({ cwd, resolved: faux(), persist: false, onStatus: () => {} });
    const tool = s.tools.find((t) => t.name === "hello_world");
    expect(tool).toBeDefined();
    expect(text(await tool!.execute("1", {}))).toBe("hello from a plugin");
    await s.dispose();
  });
});
