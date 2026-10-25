import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../src/db.ts";

/** Point LVW_HOME at a fresh temp dir for one test file. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "lvw-test-"));
  process.env.LVW_HOME = dir;
  closeDb();
  return {
    dir,
    cleanup() {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A tiny file server that honours Range, and can cut one response short to simulate a dropped connection.
 */
export function fixtureServer(files: Record<string, Uint8Array>) {
  const state = { cutNext: 0, requests: [] as { path: string; range?: string }[] };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const body = files[url.pathname.slice(1)];
      const range = req.headers.get("range") ?? undefined;
      state.requests.push({ path: url.pathname, range });
      if (!body) return new Response("nope", { status: 404 });
      let start = 0;
      if (range) start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      if (start >= body.length && start > 0) return new Response(null, { status: 416 });
      let slice = body.subarray(start);
      const headers = { "content-length": String(slice.length), "accept-ranges": "bytes" };
      if (state.cutNext > 0) {
        // Send only part of the file, as if the connection dropped.
        const cut = slice.subarray(0, state.cutNext);
        state.cutNext = 0;
        return new Response(cut as unknown as BodyInit, { status: range ? 206 : 200, headers: { "content-length": String(cut.length) } });
      }
      return new Response(slice as unknown as BodyInit, { status: range ? 206 : 200, headers });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, state, stop: () => server.stop(true) };
}
