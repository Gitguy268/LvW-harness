import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { loadConfig } from "../config.ts";
import { ensureDirs } from "../paths.ts";
import { ollamaAvailable, ollamaList, ollamaPull, ollamaRemove } from "../runtime/ollama.ts";
import { dirSize, fitFor, formatBytes, freeBytes, type Fit } from "./disk.ts";
import { resolveGh } from "./gh.ts";
import { resolveGl } from "./gl.ts";
import { resolveHf } from "./hf.ts";
import { deleteModel, findModel, listModels, saveModel, uniqueName } from "./registry.ts";
import { ggufSetKey, isGguf, isProjector, listChoices } from "./select.ts";
import { parseSpec, specToString, type Source } from "./source.ts";
import { downloadFile } from "./download.ts";
import type { ModelRecord, PullEvent, RemoteFile, ResolvedModel } from "./types.ts";

export interface PullOptions {
  pattern?: string;
  all?: boolean;
  name?: string;
  signal?: AbortSignal;
  onEvent?: (e: PullEvent) => void;
  /** Asked when a repo offers several quants and no pattern was given. Return a pattern, or undefined for the default. */
  choose?: (choices: ReturnType<typeof listChoices>, defaultPath: string) => Promise<string | undefined>;
  concurrency?: number;
}

export async function resolveSpec(spec: string | Source, opts: { pattern?: string; all?: boolean } = {}): Promise<ResolvedModel> {
  const src = typeof spec === "string" ? parseSpec(spec) : spec;
  const pattern = opts.pattern ?? ("pattern" in src ? src.pattern : undefined);
  switch (src.kind) {
    case "hf":
      return resolveHf(src.repo, src.revision, { pattern, all: opts.all });
    case "gh":
      return resolveGh(src.repo, src.tag, { pattern, all: opts.all });
    case "gl":
      return resolveGl(src.host, src.project, src.tag, { pattern, all: opts.all });
    case "url": {
      const u = new URL(src.url);
      const fileName = decodeURIComponent(u.pathname.split("/").pop() || "model.bin");
      let size: number | undefined;
      try {
        const head = await fetch(src.url, { method: "HEAD", redirect: "follow" });
        size = Number(head.headers.get("content-length")) || undefined;
      } catch {}
      const file: RemoteFile = { path: fileName, url: src.url, size };
      return { dir: `url/${u.hostname}`, available: [file], selected: [file], name: fileName.replace(/\.gguf$/i, "") };
    }
    case "ollama":
      throw new Error("Ollama models are resolved by Ollama itself.");
  }
}

function formatOf(files: string[]) {
  if (files.some(isGguf)) return "gguf";
  if (files.some((f) => f.endsWith(".safetensors"))) return "safetensors";
  if (files.some((f) => f.endsWith(".onnx"))) return "onnx";
  if (files.some((f) => /\.(bin|pt|pth)$/.test(f))) return "pytorch";
  return "files";
}

function mainFileOf(files: string[]) {
  return files.filter((f) => isGguf(f) && !isProjector(f)).sort()[0];
}

export async function pull(spec: string, opts: PullOptions = {}): Promise<ModelRecord> {
  const src = parseSpec(spec);
  const emit = opts.onEvent ?? (() => {});
  if (src.kind === "ollama") return pullOllama(src.name, opts);

  let resolved = await resolveSpec(src, { pattern: opts.pattern, all: opts.all });
  const hasPattern = Boolean(opts.pattern ?? ("pattern" in src ? src.pattern : undefined));
  if (!hasPattern && !opts.all && opts.choose) {
    const choices = listChoices(resolved.available);
    const ggufChoices = choices.filter((c) => isGguf(c.path) && !isProjector(c.path));
    if (ggufChoices.length > 1) {
      const picked = await opts.choose(ggufChoices, ggufSetKey(resolved.selected[0].path));
      if (picked) resolved = await resolveSpec(src, { pattern: picked });
    }
  }
  if (resolved.note) emit({ type: "status", text: resolved.note });

  const root = ensureDirs().models;
  const dir = join(root, resolved.dir);
  const files = resolved.selected;
  const id = createHash("sha1").update(resolved.dir + "\0" + files.map((f) => f.path).sort().join("\0")).digest("hex").slice(0, 12);
  const existing = findModel(id);
  const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
  emit({ type: "resolved", name: existing?.name ?? opts.name ?? resolved.name, files: files.map((f) => ({ path: f.path, size: f.size })), total });

  // Refuse up front if the download would leave too little free disk.
  const already = files.reduce((n, f) => {
    const p = join(dir, f.path);
    return n + (existsSync(p) ? statSync(p).size : existsSync(p + ".part") ? statSync(p + ".part").size : 0);
  }, 0);
  const free = freeBytes(root);
  const margin = loadConfig().minFreeGB * 1024 ** 3;
  if (total - already > free - margin) {
    throw new Error(
      `Not enough disk: this needs ${formatBytes(total - already)} but only ${formatBytes(free)} is free (LvW keeps ${loadConfig().minFreeGB} GB spare). Free space with \`lvw model rm <name>\` or \`lvw model gc\`.`,
    );
  }

  const progress = new Map<string, number>();
  const report = (file: string, fileDone: number, fileTotal?: number) => {
    progress.set(file, fileDone);
    let done = 0;
    for (const v of progress.values()) done += v;
    emit({ type: "progress", file, done, total, fileDone, fileTotal });
  };
  const queue = [...files];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 3, queue.length) }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const file = f;
      await downloadFile(file, join(dir, file.path), { signal: opts.signal, onProgress: (d, t) => report(file.path, d, t) });
      if (file.sha256) emit({ type: "verify", file: file.path });
      report(file.path, statSync(join(dir, file.path)).size, file.size);
    }
  });
  await Promise.all(workers);

  const paths = files.map((f) => f.path);
  const record: ModelRecord = {
    id,
    name: existing?.name ?? uniqueName(opts.name ?? resolved.name),
    source: src.kind,
    spec: specToString(src),
    dir: resolved.dir,
    files: paths,
    mainFile: mainFileOf(paths),
    size: paths.reduce((n, p) => n + statSync(join(dir, p)).size, 0),
    format: formatOf(paths),
    addedAt: existing?.addedAt ?? Date.now(),
  };
  saveModel(record);
  emit({ type: "done", model: record });
  return record;
}

async function pullOllama(name: string, opts: PullOptions): Promise<ModelRecord> {
  const emit = opts.onEvent ?? (() => {});
  if (!(await ollamaAvailable())) throw new Error("Ollama isn't running. Start it (`ollama serve` or the app) and try again.");
  emit({ type: "resolved", name: `ollama:${name}`, files: [], total: 0 });
  await ollamaPull(name, (status, done, total) => {
    if (total) emit({ type: "progress", file: status, done: done ?? 0, total, fileDone: done ?? 0, fileTotal: total });
    else emit({ type: "status", text: status });
  }, opts.signal);
  const m = (await ollamaList()).find((x) => x.name === name || x.name === `${name}:latest`);
  const record: ModelRecord = {
    id: `ollama:${m?.name ?? name}`,
    name: `ollama:${m?.name ?? name}`,
    source: "ollama",
    spec: `ollama:${name}`,
    dir: "",
    files: [],
    size: m?.size ?? 0,
    format: "ollama",
    addedAt: Date.now(),
  };
  emit({ type: "done", model: record });
  return record;
}

export function modelPath(m: ModelRecord, file = m.mainFile) {
  if (!file) throw new Error(`${m.name} has no runnable file.`);
  return join(ensureDirs().models, m.dir, file);
}

export interface ListedModel extends ModelRecord {
  runnable: boolean;
  fit: Fit;
  missing: boolean;
}

export async function listAll(): Promise<ListedModel[]> {
  const root = ensureDirs().models;
  const ctx = loadConfig().llama.ctx;
  const local = listModels().map((m) => ({
    ...m,
    runnable: Boolean(m.mainFile),
    fit: fitFor(m.size, ctx).fit,
    missing: m.files.some((f) => !existsSync(join(root, m.dir, f))),
  }));
  if (!(await ollamaAvailable())) return local;
  const ollama = (await ollamaList()).map(
    (o): ListedModel => ({
      id: `ollama:${o.name}`,
      name: `ollama:${o.name}`,
      source: "ollama",
      spec: `ollama:${o.name}`,
      dir: "",
      files: [],
      size: o.size,
      format: "ollama",
      addedAt: Date.parse(o.modified_at) || 0,
      runnable: true,
      fit: fitFor(o.size, ctx).fit,
      missing: false,
    }),
  );
  return [...local, ...ollama];
}

/** Delete a model's files (unless another model shares them) and its registry row. */
export async function removeModel(ref: string, opts: { keepFiles?: boolean } = {}): Promise<{ name: string; freed: number }> {
  if (ref.startsWith("ollama:")) {
    const name = ref.slice(7);
    const size = (await ollamaList()).find((m) => m.name === name || m.name === `${name}:latest`)?.size ?? 0;
    await ollamaRemove(name);
    return { name: ref, freed: size };
  }
  const m = findModel(ref);
  if (!m) throw new Error(`No model "${ref}". See \`lvw model ls\`.`);
  const { serverState, stopServer } = await import("../runtime/llamacpp.ts");
  if (serverState()?.modelId === m.id) await stopServer();
  const root = ensureDirs().models;
  const shared = new Set(listModels().filter((o) => o.id !== m.id && o.dir === m.dir).flatMap((o) => o.files));
  let freed = 0;
  if (!opts.keepFiles) {
    for (const f of m.files) {
      if (shared.has(f)) continue;
      for (const p of [join(root, m.dir, f), join(root, m.dir, f) + ".part"]) {
        if (!existsSync(p)) continue;
        freed += statSync(p).size;
        rmSync(p, { force: true });
      }
      pruneEmpty(dirname(join(root, m.dir, f)), root);
    }
  }
  deleteModel(m.id);
  return { name: m.name, freed };
}

function pruneEmpty(dir: string, root: string) {
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (readdirSync(dir).filter((f) => f !== ".DS_Store").length) return;
      rmSync(join(dir, ".DS_Store"), { force: true });
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

export interface GcReport {
  partials: { path: string; size: number }[];
  orphans: { path: string; size: number }[];
  missing: string[];
}

/** Find leftover `.part` files, files no model owns, and models whose files are gone. */
export function gcScan(): GcReport {
  const root = ensureDirs().models;
  const owned = new Set(listModels().flatMap((m) => m.files.map((f) => join(root, m.dir, f))));
  const report: GcReport = { partials: [], orphans: [], missing: [] };
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === ".DS_Store") continue;
      else if (p.endsWith(".part")) {
        // Leave downloads that are still being written alone.
        const st = statSync(p);
        if (Date.now() - st.mtimeMs > 60_000) report.partials.push({ path: relative(root, p), size: st.size });
      }
      else if (!owned.has(p)) report.orphans.push({ path: relative(root, p), size: statSync(p).size });
    }
  };
  if (existsSync(root)) walk(root);
  for (const m of listModels()) if (m.files.some((f) => !existsSync(join(root, m.dir, f)))) report.missing.push(m.name);
  return report;
}

export function gcApply(report: GcReport): number {
  const root = ensureDirs().models;
  let freed = 0;
  for (const f of [...report.partials, ...report.orphans]) {
    rmSync(join(root, f.path), { force: true });
    freed += f.size;
    pruneEmpty(dirname(join(root, f.path)), root);
  }
  for (const name of report.missing) {
    const m = findModel(name);
    if (m) deleteModel(m.id);
  }
  return freed;
}

export function diskUsage() {
  const root = ensureDirs().models;
  return { used: dirSize(root), free: freeBytes(root), models: listModels().map((m) => ({ name: m.name, size: m.size })) };
}
