import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig, DEFAULTS } from "../src/config.ts";
import { downloadFile } from "../src/models/download.ts";
import { gcApply, gcScan, pull, removeModel } from "../src/models/manager.ts";
import { findModel, listModels } from "../src/models/registry.ts";
import { fixtureServer, tempHome } from "./helpers.ts";

const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) % 251);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let home: ReturnType<typeof tempHome>;
let srv: ReturnType<typeof fixtureServer>;

beforeAll(() => {
  home = tempHome();
  saveConfig({ ...DEFAULTS, minFreeGB: 0 });
  srv = fixtureServer({ "tiny-Q4_K_M.gguf": big, "other.bin": new Uint8Array([1, 2, 3]) });
});
afterAll(() => {
  srv.stop();
  home.cleanup();
});

describe("downloadFile", () => {
  test("resumes after a dropped connection and verifies sha256", async () => {
    const dest = join(home.dir, "dl", "a.gguf");
    srv.state.cutNext = 1024 * 1024;
    await downloadFile({ path: "a.gguf", url: `${srv.url}/tiny-Q4_K_M.gguf`, size: big.length, sha256: sha(big) }, dest, { retries: 2 });
    expect(statSync(dest).size).toBe(big.length);
    expect(sha(readFileSync(dest))).toBe(sha(big));
    expect(srv.state.requests.at(-1)?.range).toBe(`bytes=${1024 * 1024}-`);
  });

  test("resumes from an existing .part file", async () => {
    const dest = join(home.dir, "dl", "b.gguf");
    writeFileSync(dest + ".part", big.subarray(0, 500_000));
    await downloadFile({ path: "b.gguf", url: `${srv.url}/tiny-Q4_K_M.gguf`, size: big.length, sha256: sha(big) }, dest);
    expect(sha(readFileSync(dest))).toBe(sha(big));
    expect(srv.state.requests.at(-1)?.range).toBe("bytes=500000-");
  });

  test("rejects a checksum mismatch and deletes the partial file", async () => {
    const dest = join(home.dir, "dl", "c.gguf");
    await expect(downloadFile({ path: "c.gguf", url: `${srv.url}/tiny-Q4_K_M.gguf`, size: big.length, sha256: "0".repeat(64) }, dest)).rejects.toThrow(/Checksum mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(dest + ".part")).toBe(false);
  });

  test("a 404 fails fast", async () => {
    await expect(downloadFile({ path: "x", url: `${srv.url}/missing` }, join(home.dir, "dl", "x"))).rejects.toThrow(/404/);
  });
});

describe("pull / rm / gc", () => {
  test("pull a URL, then remove it and free the space", async () => {
    const events: string[] = [];
    const m = await pull(`${srv.url}/tiny-Q4_K_M.gguf`, { onEvent: (e) => events.push(e.type) });
    expect(m.format).toBe("gguf");
    expect(m.mainFile).toBe("tiny-Q4_K_M.gguf");
    expect(m.size).toBe(big.length);
    expect(events).toContain("done");
    expect(findModel("tiny")?.id).toBe(m.id);

    const again = await pull(`${srv.url}/tiny-Q4_K_M.gguf`);
    expect(again.name).toBe(m.name);
    expect(listModels()).toHaveLength(1);

    const file = join(home.dir, "models", m.dir, m.mainFile!);
    expect(existsSync(file)).toBe(true);
    const { freed } = await removeModel(m.name);
    expect(freed).toBe(big.length);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(home.dir, "models", m.dir))).toBe(false);
    expect(listModels()).toHaveLength(0);
  });

  test("refuses when the disk margin would be crossed", async () => {
    saveConfig({ ...DEFAULTS, minFreeGB: 1e9 });
    await expect(pull(`${srv.url}/other.bin`)).rejects.toThrow(/Not enough disk/);
    saveConfig({ ...DEFAULTS, minFreeGB: 0 });
  });

  test("gc finds orphans and models with missing files", async () => {
    const m = await pull(`${srv.url}/other.bin`);
    writeFileSync(join(home.dir, "models", m.dir, "stray.bin"), "x");
    const rep = gcScan();
    expect(rep.orphans.map((o) => o.path)).toContain(join(m.dir, "stray.bin"));
    gcApply(rep);
    expect(existsSync(join(home.dir, "models", m.dir, "stray.bin"))).toBe(false);
    expect(findModel(m.name)).toBeDefined();
    await removeModel(m.name);
  });
});
