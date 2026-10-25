import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { RemoteFile } from "./types.ts";

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Called with the number of bytes written to disk so far for this file. */
  onProgress?: (done: number, total?: number) => void;
  retries?: number;
}

const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";

async function hashFile(path: string, hash: ReturnType<typeof createHash>) {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

/**
 * Download to `<dest>.part`, resuming with HTTP Range, then verify sha256 (when the source gives one)
 * and move into place. A finished file at `dest` with the right size is left alone.
 */
export async function downloadFile(file: RemoteFile, dest: string, opts: DownloadOptions = {}): Promise<{ size: number; skipped: boolean }> {
  if (existsSync(dest) && (file.size === undefined || statSync(dest).size === file.size)) {
    return { size: statSync(dest).size, skipped: true };
  }
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let url = file.url;
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      await fetchInto(url, part, file, opts);
      if (file.lfsUrl && url !== file.lfsUrl && (await isLfsPointer(part))) {
        rmSync(part);
        url = file.lfsUrl;
        continue;
      }
      break;
    } catch (err) {
      if (opts.signal?.aborted || (err as Error).name === "IntegrityError" || attempt >= retries || (err as { fatal?: boolean }).fatal) throw err;
      await Bun.sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
  if (file.sha256) {
    const hash = createHash("sha256");
    await hashFile(part, hash);
    const got = hash.digest("hex");
    if (got !== file.sha256.toLowerCase()) {
      rmSync(part, { force: true });
      const e = new Error(`Checksum mismatch for ${file.path}: expected ${file.sha256}, got ${got}. The partial file was deleted.`);
      e.name = "IntegrityError";
      throw e;
    }
  }
  renameSync(part, dest);
  return { size: statSync(dest).size, skipped: false };
}

async function isLfsPointer(path: string) {
  if (statSync(path).size > 1024) return false;
  return (await Bun.file(path).text()).startsWith(LFS_POINTER);
}

async function fetchInto(url: string, part: string, file: RemoteFile, opts: DownloadOptions) {
  let offset = existsSync(part) ? statSync(part).size : 0;
  if (file.size !== undefined && offset === file.size) return;
  if (file.size !== undefined && offset > file.size) {
    rmSync(part);
    offset = 0;
  }
  const headers: Record<string, string> = { ...(file.headers ?? {}) };
  if (offset > 0) headers.range = `bytes=${offset}-`;
  const res = await fetch(url, { headers, signal: opts.signal, redirect: "follow" });
  if (res.status === 416) return; // already complete
  if (!res.ok) {
    const e = new Error(`Download of ${file.path} failed: HTTP ${res.status}`) as Error & { fatal?: boolean };
    e.fatal = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw e;
  }
  if (offset > 0 && res.status !== 206) offset = 0; // server ignored Range: start over
  const length = Number(res.headers.get("content-length")) || undefined;
  const total = file.size ?? (length === undefined ? undefined : length + (res.status === 206 ? offset : 0));
  const out = createWriteStream(part, { flags: offset > 0 ? "a" : "w" });
  let done = offset;
  let lastReport = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      done += chunk.byteLength;
      const now = Date.now();
      if (now - lastReport > 200) {
        lastReport = now;
        opts.onProgress?.(done, total);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  opts.onProgress?.(done, total);
  if (total !== undefined && done < total) throw new Error(`Connection closed early for ${file.path} (${done}/${total} bytes)`);
}
