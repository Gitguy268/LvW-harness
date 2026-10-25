import { mkdirSync, readdirSync, statfsSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";

export function freeBytes(dir: string): number {
  mkdirSync(dir, { recursive: true });
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      total += entry.isDirectory() ? dirSize(p) : entry.isFile() ? statSync(p).size : 0;
    }
  } catch {}
  return total;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export type Fit = "fits" | "tight" | "too big";

/**
 * Rough memory check, an idea from odysseus's hardware-aware model cookbook: weights plus a KV cache
 * allowance for the context size. On Apple silicon the GPU can use about 75% of unified memory.
 */
export function fitFor(modelBytes: number, ctx = 8192): { fit: Fit; needed: number; ram: number } {
  const ram = totalmem();
  const kv = Math.min(4, ctx / 8192) * 0.6 * 1024 ** 3 * Math.max(0.5, Math.min(2, modelBytes / 4 / 1024 ** 3));
  const needed = modelBytes * 1.08 + kv + 300 * 1024 ** 2;
  const usable = process.platform === "darwin" ? ram * 0.75 : ram * 0.85;
  return { fit: needed < usable * 0.8 ? "fits" : needed < usable ? "tight" : "too big", needed, ram };
}
