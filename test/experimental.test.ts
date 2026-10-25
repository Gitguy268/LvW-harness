import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunks, runBot } from "../src/channels/telegram.ts";
import type { ResolvedChatModel } from "../src/core/providers.ts";
import { improve, listProfiles, loadProfile, saveProfile, scratchCopy, STRATEGIES } from "../src/orchestra/improve.ts";
import { tempHome } from "./helpers.ts";

let home: ReturnType<typeof tempHome>;
beforeAll(() => (home = tempHome()));
afterAll(() => home.cleanup());

function faux() {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  const resolved: ResolvedChatModel = { models, model: f.getModel(), label: "faux", local: true };
  return { f, resolved };
}

describe("improve", () => {
  test("scratch copy leaves node_modules and .git out", () => {
    const src = mkdtempSync(join(tmpdir(), "lvw-src-"));
    writeFileSync(join(src, "a.txt"), "a");
    mkdirSync(join(src, "node_modules"));
    writeFileSync(join(src, "node_modules", "big.js"), "x");
    const { dir, copied } = scratchCopy(src);
    expect(copied).toBe(true);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  test("probes each strategy in a copy, grades it and ranks the best first", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lvw-cwd-"));
    const { f, resolved } = faux();
    const two = STRATEGIES.slice(0, 2);
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("write_file", { path: "out.txt", content: "1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Wrote out.txt")]),
      fauxAssistantMessage([fauxText('{"score": 6, "reason": "ok"}')]),
      fauxAssistantMessage([fauxText("Did it")]),
      fauxAssistantMessage([fauxText('{"score": 9, "reason": "clean"}')]),
    ]);
    const results = await improve({ task: "write out.txt", cwd, resolved, strategies: two });
    expect(results.map((r) => [r.strategy, r.score])).toEqual([
      ["plan-first", 9],
      ["baseline", 6],
    ]);
    expect(results[1].toolCalls).toBe(1);
    // Probes run in copies, never in the real folder.
    expect(existsSync(join(cwd, "out.txt"))).toBe(false);
  });

  test("profiles round-trip and reject odd names", () => {
    saveProfile({ name: "p1", strategy: "verify", prompt: "check", task: "t", model: "m", scores: [], created_at: 1 });
    expect(loadProfile("p1").prompt).toBe("check");
    expect(listProfiles().map((p) => p.name)).toContain("p1");
    expect(() => loadProfile("../x")).toThrow();
  });
});

describe("telegram", () => {
  test("splits long answers under Telegram's limit", () => {
    const parts = chunks("a".repeat(9000));
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
  });

  test("answers allowed chats, asks approval with buttons, turns others away", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lvw-tg-"));
    const queue: unknown[] = [
      { update_id: 1, message: { chat: { id: 99 }, text: "hello" } },
      { update_id: 2, message: { chat: { id: 7 }, text: "write a note" } },
    ];
    const sent: { method: string; body: Record<string, unknown> }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const method = new URL(req.url).pathname.split("/").pop()!;
        const body = (await req.json()) as Record<string, unknown>;
        if (method === "getUpdates") {
          await Bun.sleep(20);
          return Response.json({ ok: true, result: queue.splice(0) });
        }
        sent.push({ method, body });
        // Press "Yes" on the approval keyboard.
        const markup = body.reply_markup as { inline_keyboard: { callback_data: string }[][] } | undefined;
        if (markup) queue.push({ update_id: 3, callback_query: { id: "cb", data: markup.inline_keyboard[0][0].callback_data } });
        return Response.json({ ok: true, result: {} });
      },
    });
    const { f, resolved } = faux();
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("write_file", { path: "note.txt", content: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Saved note.txt")]),
    ]);
    const ctrl = new AbortController();
    const bot = runBot({ token: "T", allowed: [7], cwd, resolved, api: `http://127.0.0.1:${server.port}`, signal: ctrl.signal });
    for (let i = 0; i < 100 && !sent.some((s) => s.body.text === "Saved note.txt"); i++) await Bun.sleep(30);
    ctrl.abort();
    await bot.catch(() => {});
    server.stop(true);

    const texts = sent.filter((s) => s.method === "sendMessage").map((s) => [s.body.chat_id, String(s.body.text)] as const);
    expect(texts.find(([id]) => id === 99)?.[1]).toContain("allowedChatIds '[99]'");
    expect(texts.some(([id, t]) => id === 7 && t.startsWith("Allow write_file?"))).toBe(true);
    expect(sent.some((s) => s.method === "answerCallbackQuery")).toBe(true);
    expect(texts).toContainEqual([7, "Saved note.txt"]);
    expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("hi");
  });
});
