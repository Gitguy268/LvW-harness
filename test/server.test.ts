import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cronMatches, parseCron } from "../src/orchestra/routines.ts";
import { createServer } from "../src/server/server.ts";
import { tempHome } from "./helpers.ts";

let home: ReturnType<typeof tempHome>;
let cwd: string;
let open: ReturnType<typeof createServer>;
let locked: ReturnType<typeof createServer>;
beforeAll(() => {
  home = tempHome();
  cwd = mkdtempSync(join(tmpdir(), "lvw-srv-"));
  writeFileSync(join(cwd, "page.html"), "<h1>hi</h1>");
  open = createServer({ host: "127.0.0.1", port: 0, cwd });
  locked = createServer({ host: "127.0.0.1", port: 0, cwd, token: "s3cret" });
});
afterAll(() => {
  open.stop(true);
  locked.stop(true);
  home.cleanup();
});

const base = (s: { port?: number }) => `http://127.0.0.1:${s.port}`;

describe("server guards", () => {
  test("same-machine request without Origin is allowed", async () => {
    expect((await fetch(`${base(open)}/api/routines`)).status).toBe(200);
  });

  test("a foreign Origin is refused, for the API and the WebSocket", async () => {
    const headers = { origin: "https://evil.example" };
    expect((await fetch(`${base(open)}/api/routines`, { headers })).status).toBe(403);
    expect((await fetch(`${base(open)}/api/models/pull`, { method: "POST", headers, body: '{"spec":"hf:a/b"}' })).status).toBe(403);
    const ws = await fetch(`${base(open)}/ws`, { headers: { ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    expect(ws.status).toBe(403);
  });

  test("a foreign Host (DNS rebinding) is refused", async () => {
    expect((await fetch(`${base(open)}/api/routines`, { headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("its own Origin is allowed", async () => {
    expect((await fetch(`${base(open)}/api/routines`, { headers: { origin: base(open) } })).status).toBe(200);
  });

  test("token mode needs the token", async () => {
    expect((await fetch(`${base(locked)}/api/routines`)).status).toBe(401);
    expect((await fetch(`${base(locked)}/api/routines`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
    expect((await fetch(`${base(locked)}/api/login`, { method: "POST", body: '{"token":"nope"}' })).status).toBe(401);
  });

  test("preview serves files in the working folder only", async () => {
    expect((await fetch(`${base(open)}/api/preview?path=page.html`)).status).toBe(200);
    expect((await fetch(`${base(open)}/api/preview?path=../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base(open)}/api/preview?path=/etc/passwd`)).status).toBe(404);
  });
});

describe("cron", () => {
  const at = (s: string) => new Date(s);
  test("steps and ranges", () => {
    expect([...parseCron("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 9-11 * * *").hour]).toEqual([9, 10, 11]);
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow();
  });

  test("7 means Sunday", () => {
    // 2026-10-25 is a Sunday.
    expect(cronMatches("0 9 * * 7", at("2026-10-25T09:00:00"))).toBe(true);
    expect(cronMatches("0 9 * * 0", at("2026-10-25T09:00:00"))).toBe(true);
    expect(cronMatches("0 9 * * 1", at("2026-10-25T09:00:00"))).toBe(false);
  });

  test("day-of-month and day-of-week are ORed when both are set", () => {
    // The 1st, or any Monday. 2026-10-26 is a Monday, 2026-10-27 a Tuesday.
    expect(cronMatches("0 0 1 * 1", at("2026-10-26T00:00:00"))).toBe(true);
    expect(cronMatches("0 0 1 * 1", at("2026-11-01T00:00:00"))).toBe(true);
    expect(cronMatches("0 0 1 * 1", at("2026-10-27T00:00:00"))).toBe(false);
  });
});
