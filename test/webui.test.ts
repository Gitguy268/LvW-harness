import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The web UI talks to one of two backends: the native server, or the in-page harness (hub.ts).
// Every /api path the UI calls must have a route in the in-page harness too.
const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "src/web/app.js"), "utf8");
const hub = readFileSync(join(root, "src/webui/backend/hub.ts"), "utf8");

const routes = [...hub.matchAll(/route\("(GET|POST|PUT|PATCH|DELETE)", "([^"]+)"/g)].map(([, method, path]) => ({
  method,
  re: new RegExp(`^${path.replace(/:\w+/g, "[^/]+").replace(/\*$/, ".*")}$`),
}));

/** api("/api/x", { method: "POST" … }) and api(`/api/x/${id}`…) calls, with their methods. */
const calls = [...app.matchAll(/api\((["`])(\/api\/[^"`?]*)[^"`]*\1(?:,\s*\{\s*method:\s*"(\w+)")?/g)].map(([, , path, method]) => ({
  path: path.replace(/\$\{[^}]+\}/g, "x"),
  method: method ?? "GET",
}));

describe("web UI parity", () => {
  test("the UI calls a good number of API paths (the parser works)", () => {
    expect(calls.length).toBeGreaterThan(30);
  });
  test("every API path the UI calls exists in the in-browser harness", () => {
    const missing = calls.filter((c) => !routes.some((r) => r.method === c.method && r.re.test(c.path)));
    // Approvals of tasks and login exist only on a server.
    const serverOnly = missing.filter((c) => !/^\/api\/(login|approvals\/x)$/.test(c.path));
    expect(serverOnly).toEqual([]);
  });
});
