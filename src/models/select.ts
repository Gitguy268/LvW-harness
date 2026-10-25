import { matchesPattern } from "./source.ts";
import type { RemoteFile } from "./types.ts";

const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
const PREFERRED_QUANTS = ["Q4_K_M", "Q4_K_S", "Q4_0", "IQ4_XS", "Q5_K_M", "Q6_K", "Q8_0"];

export const isGguf = (p: string) => p.toLowerCase().endsWith(".gguf");
export const isProjector = (p: string) => /(^|\/)mmproj/i.test(p);

/** `model-00001-of-00003.gguf` and its siblings share one set key. */
export function ggufSetKey(path: string) {
  return path.replace(SHARD, ".gguf");
}

export function quantOf(path: string): string | undefined {
  const name = path.split("/").pop()!;
  const m = name.match(/(?:^|[-._])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|F32|MXFP4)(?=[-._])/gi);
  return m?.at(-1)?.replace(/^[-._]/, "").toUpperCase();
}

function ggufSets(files: RemoteFile[]) {
  const sets = new Map<string, RemoteFile[]>();
  for (const f of files) {
    if (!isGguf(f.path) || isProjector(f.path)) continue;
    const key = ggufSetKey(f.path);
    sets.set(key, [...(sets.get(key) ?? []), f]);
  }
  return sets;
}

const setSize = (fs: RemoteFile[]) => fs.reduce((n, f) => n + (f.size ?? 0), 0);

export interface Selection {
  files: RemoteFile[];
  note?: string;
}

/**
 * Decide what to download. With a pattern: those files (whole GGUF shard sets).
 * Without one: a GGUF repo gives one quant (Q4_K_M if present); any other repo gives every file.
 */
export function selectFiles(available: RemoteFile[], opts: { pattern?: string; all?: boolean }): Selection {
  const usable = available.filter((f) => !f.path.endsWith(".gitattributes"));
  if (opts.all) return { files: usable };
  const sets = ggufSets(usable);
  if (opts.pattern) {
    const hits = usable.filter((f) => matchesPattern(f.path, opts.pattern!));
    if (!hits.length) {
      const quants = [...new Set([...sets.keys()].map(quantOf).filter(Boolean))];
      throw new Error(
        `Nothing matches "${opts.pattern}".` + (quants.length ? ` Available quants: ${quants.join(", ")}` : ` Files: ${usable.slice(0, 15).map((f) => f.path).join(", ")}`),
      );
    }
    const out = new Map<string, RemoteFile>();
    for (const hit of hits) {
      const group = isGguf(hit.path) && !isProjector(hit.path) ? sets.get(ggufSetKey(hit.path)) ?? [hit] : [hit];
      for (const f of group) out.set(f.path, f);
    }
    return { files: [...out.values()] };
  }
  if (sets.size === 0) return { files: usable, note: "No GGUF files: downloading the whole repository." };
  if (sets.size === 1) return { files: [...sets.values()][0] };
  for (const q of PREFERRED_QUANTS) {
    const match = [...sets.entries()].find(([key]) => quantOf(key) === q);
    if (match) return { files: match[1], note: `Picked ${q} out of ${sets.size} quants. Add :<quant> to choose another.` };
  }
  const smallest = [...sets.values()].sort((a, b) => setSize(a) - setSize(b))[0];
  return { files: smallest, note: `Picked the smallest of ${sets.size} GGUF files. Add :<pattern> to choose another.` };
}

/** One line per choice, for the CLI and web UI pickers. */
export function listChoices(available: RemoteFile[]) {
  const sets = ggufSets(available);
  if (sets.size) {
    return [...sets.entries()].map(([key, files]) => ({ pattern: quantOf(key) ?? key, path: key, size: setSize(files), parts: files.length }));
  }
  return available.map((f) => ({ pattern: f.path, path: f.path, size: f.size ?? 0, parts: 1 }));
}
