/**
 * Models in the browser: find them on Hugging Face, GitHub or GitLab with the harness's own
 * resolvers, download them into this site's private storage (OPFS) in ranged, resumable chunks
 * with a SHA-256 check, and hand the files to wllama.
 */
import { createSHA256 } from "hash-wasm";
import { resolveGh } from "../../models/gh.ts";
import { resolveGl } from "../../models/gl.ts";
import { resolveHf } from "../../models/hf.ts";
import { isGguf, isProjector, listChoices, quantOf } from "../../models/select.ts";
import { parseSpec, type Source } from "../../models/source.ts";
import type { RemoteFile, ResolvedModel } from "../../models/types.ts";
import { db } from "./db.ts";

/** wllama reads each file into one ArrayBuffer, which browsers cap at 2 GB. */
export const MAX_FILE = 2 * 1024 ** 3 - 1;
const CHUNK = 32 * 1024 * 1024;

export interface BrowserModel {
  id: string;
  name: string;
  source: string;
  spec: string;
  dir: string;
  files: { path: string; size: number; sha256?: string }[];
  mainFile?: string;
  size: number;
  format: string;
  addedAt: number;
  lastUsed?: number;
}

export async function resolveSpec(spec: string, opts: { pattern?: string; all?: boolean } = {}): Promise<ResolvedModel> {
  const src: Source = parseSpec(spec);
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
        const r = await fetch(src.url, { headers: { range: "bytes=0-0" }, cache: "no-store" });
        size = Number(r.headers.get("content-range")?.split("/")[1]) || Number(r.headers.get("content-length")) || undefined;
        await r.body?.cancel();
      } catch {}
      const file: RemoteFile = { path: fileName, url: src.url, size };
      return { dir: `url/${u.hostname}`, available: [file], selected: [file], name: fileName.replace(/\.gguf$/i, "") };
    }
    case "ollama":
      throw new Error("Ollama models need Ollama. Connect this page to an LvW-harness on a computer that runs Ollama, or use a GGUF from Hugging Face.");
  }
}

/** "fits", "tight" or "big" for the browser: per-file 2 GB limit and the device's memory. */
export function browserFit(size: number): "fits" | "tight" | "big" {
  if (size > MAX_FILE) return "big";
  const mem = ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) * 1024 ** 3;
  return size < mem * 0.25 ? "fits" : size < mem * 0.5 ? "tight" : "big";
}

export async function inspect(spec: string) {
  const r = await resolveSpec(spec);
  return {
    dir: r.dir,
    name: r.name,
    note: r.note,
    selected: r.selected.map((f) => f.path),
    choices: listChoices(r.available).map((c) => ({ ...c, fit: c.size ? browserFit(c.size) : undefined })),
  };
}

async function modelsRoot() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle("models", { create: true });
}

async function dirFor(path: string, create: boolean) {
  let d = await modelsRoot();
  for (const part of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}

async function fileHandle(path: string, create: boolean) {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await dirFor(parent, create)).getFileHandle(path.split("/").pop()!, { create });
}

export async function listModels(): Promise<(BrowserModel & { runnable: boolean; role: string; fit: string; missing: boolean })[]> {
  const out = [];
  for (const m of await db.all<BrowserModel>("models")) {
    let missing = false;
    for (const f of m.files) {
      try {
        const file = await (await fileHandle(`${m.dir}/${f.path}`, false)).getFile();
        if (file.size !== f.size) missing = true;
      } catch {
        missing = true;
      }
    }
    out.push({ ...m, runnable: Boolean(m.mainFile) && !missing && !isWhisper(m), role: isWhisper(m) ? "transcribe" : m.files.some((f) => isProjector(f.path)) ? "vision" : "chat", fit: browserFit(m.size), missing });
  }
  return out.sort((a, b) => b.addedAt - a.addedAt);
}

export async function findModel(ref: string): Promise<BrowserModel | undefined> {
  const all = await db.all<BrowserModel>("models");
  return all.find((m) => m.name === ref || m.id === ref) ?? all.find((m) => m.name.toLowerCase().startsWith(ref.toLowerCase()));
}

/** The files wllama needs: the model (all shards) and its projector, as File objects from OPFS. */
export async function openModel(m: BrowserModel): Promise<File[]> {
  const files: File[] = [];
  for (const f of m.files.filter((x) => isGguf(x.path))) {
    const file = await (await fileHandle(`${m.dir}/${f.path}`, false)).getFile();
    if (file.size > MAX_FILE) throw new Error(`${f.path} is ${(file.size / 1024 ** 3).toFixed(2)} GB; the browser can load at most 2 GB per file. Pick a smaller quant.`);
    files.push(new File([file], f.path.split("/").pop()!));
  }
  return files;
}

/** The same files without the 2 GB check, for engines that read them in pieces (whisper.cpp). */
export const openModelRaw = (m: BrowserModel) => openModel(m);

/** whisper.cpp files (ggml, sometimes named .gguf) are for speech to text, not chat. */
export const isWhisper = (m: { spec: string; files: { path: string }[] }) => /whisper/i.test(m.spec) || m.files.some((f) => /(^|\/)ggml-|whisper/i.test(f.path));

export async function removeModel(ref: string) {
  const m = await findModel(ref);
  if (!m) throw new Error(`No model "${ref}".`);
  for (const f of m.files) {
    try {
      const parent = `${m.dir}/${f.path}`.split("/").slice(0, -1).join("/");
      await (await dirFor(parent, false)).removeEntry(f.path.split("/").pop()!);
    } catch {}
  }
  await db.del("models", m.id);
  return { freed: m.size };
}

const short = (s: string) => s.replace(/[^\w.-]+/g, "_");

export interface PullJob {
  id: string;
  spec: string;
  status: "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  file?: string;
  note?: string;
  error?: string;
  model?: BrowserModel;
}

/** Download a model. `emit` gets the job after every change (throttled by the caller). */
export async function pull(spec: string, opts: { pattern?: string; all?: boolean; signal: AbortSignal; emit: (j: PullJob) => void; job: PullJob }) {
  const job = opts.job;
  const r = await resolveSpec(spec, opts);
  const files = r.selected;
  const tooBig = files.find((f) => (f.size ?? 0) > MAX_FILE);
  if (tooBig) throw new Error(`${tooBig.path} is ${((tooBig.size ?? 0) / 1024 ** 3).toFixed(2)} GB. The browser can load at most 2 GB per file, so pick a smaller quant (or a split GGUF).`);
  job.total = files.reduce((n, f) => n + (f.size ?? 0), 0);
  const est = await navigator.storage.estimate();
  const free = (est.quota ?? 0) - (est.usage ?? 0);
  if (est.quota && job.total > free) throw new Error(`This needs ${(job.total / 1024 ** 3).toFixed(2)} GB but the browser allows this site only ${(free / 1024 ** 3).toFixed(2)} GB more. Remove models, or allow more storage.`);
  await (navigator.storage as unknown as { persist?: () => Promise<boolean> }).persist?.();
  let before = 0;
  const sizes = new Map<string, number>();
  for (const f of files) {
    job.file = f.path;
    const n = await download(f, `${r.dir}/${f.path}`, opts.signal, (d) => {
      job.done = before + d;
      opts.emit(job);
    }, (note) => ((job.note = note), opts.emit(job)));
    sizes.set(f.path, n);
    before += n;
  }
  job.total = before;
  const main = files.filter((f) => isGguf(f.path) && !isProjector(f.path)).map((f) => f.path).sort()[0];
  const id = short(`${r.dir}/${files.map((f) => f.path).sort().join("+")}`).slice(0, 120);
  const existing = await db.get<BrowserModel>("models", id);
  const names = new Set((await db.all<BrowserModel>("models")).filter((m) => m.id !== id).map((m) => m.name));
  let name = existing?.name ?? (main ? main.split("/").pop()!.replace(/\.gguf$/i, "") : r.name);
  for (let i = 2; names.has(name); i++) name = `${r.name}-${i}`;
  const model: BrowserModel = {
    id,
    name,
    source: spec.split(":")[0],
    spec,
    dir: r.dir,
    files: files.map((f) => ({ path: f.path, size: sizes.get(f.path) ?? f.size ?? 0, sha256: f.sha256 })),
    mainFile: main,
    size: job.total,
    format: main ? `gguf${quantOf(main) ? ` ${quantOf(main)}` : ""}` : "files",
    addedAt: existing?.addedAt ?? Date.now(),
  };
  await db.put("models", id, model);
  return model;
}

const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";

/**
 * Raw GitHub (and some GitLab) URLs serve Git LFS files as a small pointer. Read the first bytes:
 * a pointer gives the real URL, size and SHA-256 (as the native downloader does).
 */
async function followLfs(f: RemoteFile, signal: AbortSignal): Promise<RemoteFile> {
  if (!f.lfsUrl || (f.size !== undefined && f.size > 1024)) return f;
  const res = await fetch(f.url, { cache: "no-store", headers: { ...(f.headers ?? {}), range: "bytes=0-511" }, signal });
  if (!res.ok) return f;
  const head = await res.text();
  if (!head.startsWith(LFS_POINTER)) return f;
  const size = Number(/^size (\d+)$/m.exec(head)?.[1]) || undefined;
  const sha256 = /^oid sha256:([0-9a-f]{64})$/m.exec(head)?.[1];
  return { ...f, url: f.lfsUrl, size: f.size && f.size > 1024 ? f.size : size, sha256: f.sha256 ?? sha256 };
}

/** Ranged download into OPFS, resuming a .part file, with a streaming SHA-256 check when the source gives one. Returns the size written. */
async function download(file: RemoteFile, path: string, signal: AbortSignal, progress: (done: number) => void, note: (s: string) => void): Promise<number> {
  const f = await followLfs(file, signal);
  const final = await fileHandle(path, true);
  const have = await final.getFile();
  if (f.size && have.size === f.size) {
    progress(f.size);
    return f.size;
  }
  const part = await fileHandle(`${path}.part`, true);
  let offset = (await part.getFile()).size;
  const hasher = f.sha256 ? await createSHA256() : undefined;
  if (hasher && offset) {
    note(`Checking the ${(offset / 1024 ** 2).toFixed(0)} MB already downloaded…`);
    const existing = await part.getFile();
    for (let p = 0; p < offset; p += CHUNK) hasher.update(new Uint8Array(await existing.slice(p, p + CHUNK).arrayBuffer()));
  }
  const writer = await part.createWritable({ keepExistingData: true });
  await writer.seek(offset);
  const total = f.size;
  try {
    while (total === undefined || offset < total) {
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      const end = total === undefined ? "" : Math.min(total, offset + CHUNK) - 1;
      let chunk: Uint8Array | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(f.url, { cache: "no-store", headers: { ...(f.headers ?? {}), range: `bytes=${offset}-${end}` }, signal });
          if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`The server refused the download (${res.status}). For gated or private models add a token in Settings.`), { fatal: true });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if (res.status === 200 && offset > 0) {
            await res.body?.cancel();
            throw Object.assign(new Error("The server ignored the range request, so the download can't resume."), { fatal: true });
          }
          // Read as ArrayBuffer: big Blob reads fail in some Chromium setups.
          chunk = new Uint8Array(await res.arrayBuffer());
          break;
        } catch (err) {
          if (signal.aborted || (err as { fatal?: boolean }).fatal || attempt >= 4) throw err;
          note(`Network hiccup, retrying (${attempt + 1}/4)…`);
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      if (!chunk.length) break;
      await writer.write(chunk as Uint8Array<ArrayBuffer>);
      hasher?.update(chunk);
      offset += chunk.length;
      progress(offset);
      if (total === undefined && chunk.length < CHUNK) break;
    }
    await writer.close();
  } catch (err) {
    await writer.close().catch(() => {});
    throw err;
  }
  if (hasher) {
    note("Checking the file's SHA-256…");
    const digest = hasher.digest("hex");
    if (digest !== f.sha256) {
      const parent = path.split("/").slice(0, -1).join("/");
      await (await dirFor(parent, false)).removeEntry(`${path.split("/").pop()}.part`).catch(() => {});
      throw new Error(`${f.path} doesn't match its published SHA-256 (got ${digest.slice(0, 12)}…, expected ${f.sha256!.slice(0, 12)}…). It was deleted; download again.`);
    }
  }
  // Rename .part → final (OPFS move() where supported, else copy).
  const p = part as unknown as { move?: (name: string) => Promise<void> };
  if (p.move) {
    await (await dirFor(path.split("/").slice(0, -1).join("/"), false)).removeEntry(path.split("/").pop()!).catch(() => {});
    await p.move(path.split("/").pop()!);
  } else {
    const w = await final.createWritable();
    await w.write(await part.getFile());
    await w.close();
    await (await dirFor(path.split("/").slice(0, -1).join("/"), false)).removeEntry(`${path.split("/").pop()}.part`);
  }
  return (await (await fileHandle(path, false)).getFile()).size;
}

/** Add GGUF files from this computer (a model, optionally with its mmproj) as one model. */
export async function importFiles(files: File[], onProgress?: (done: number, total: number) => void): Promise<BrowserModel> {
  if (!files.length) throw new Error("Pick at least one .gguf file.");
  for (const f of files) {
    if (!/\.gguf$/i.test(f.name)) throw new Error(`${f.name} isn't a .gguf file.`);
    if (f.size > MAX_FILE) throw new Error(`${f.name} is ${(f.size / 1024 ** 3).toFixed(2)} GB; the browser can load at most 2 GB per file.`);
    const magic = new TextDecoder().decode(await f.slice(0, 4).arrayBuffer());
    if (magic !== "GGUF") throw new Error(`${f.name} doesn't start like a GGUF file.`);
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  const est = await navigator.storage.estimate();
  if (est.quota && total > est.quota - (est.usage ?? 0)) throw new Error("Not enough room in the browser's storage for these files.");
  const main = files.find((f) => !isProjector(f.name)) ?? files[0];
  const dir = `upload/${short(main.name.replace(/\.gguf$/i, ""))}`;
  let done = 0;
  const out: BrowserModel["files"] = [];
  for (const f of files) {
    const hasher = await createSHA256();
    const w = await (await fileHandle(`${dir}/${f.name}`, true)).createWritable();
    for (let p = 0; p < f.size; p += CHUNK) {
      const chunk = new Uint8Array(await f.slice(p, p + CHUNK).arrayBuffer());
      hasher.update(chunk);
      await w.write(chunk);
      done += chunk.length;
      onProgress?.(done, total);
    }
    await w.close();
    out.push({ path: f.name, size: f.size, sha256: hasher.digest("hex") });
  }
  const id = short(`${dir}/${files.map((f) => f.name).sort().join("+")}`).slice(0, 120);
  const model: BrowserModel = {
    id,
    name: main.name.replace(/\.gguf$/i, ""),
    source: "upload",
    spec: `file:${files.map((f) => f.name).join("+")}`,
    dir,
    files: out,
    mainFile: main.name,
    size: total,
    format: `gguf${quantOf(main.name) ? ` ${quantOf(main.name)}` : ""}`,
    addedAt: Date.now(),
  };
  await db.put("models", id, model);
  return model;
}

export async function disk() {
  const est = await navigator.storage.estimate();
  let used = 0;
  for (const m of await db.all<BrowserModel>("models")) used += m.size;
  return { used, free: Math.max(0, (est.quota ?? 0) - (est.usage ?? 0)), quota: est.quota ?? 0 };
}

/** Leftover .part files and models whose files are gone. */
export async function gcScan() {
  const partials: { path: string; size: number }[] = [];
  const walk = async (d: FileSystemDirectoryHandle, at: string) => {
    for await (const [name, h] of d as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      const p = at ? `${at}/${name}` : name;
      if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, p);
      else if (name.endsWith(".part")) partials.push({ path: p, size: (await (h as FileSystemFileHandle).getFile()).size });
    }
  };
  await walk(await modelsRoot(), "");
  const missing = (await listModels()).filter((m) => m.missing).map((m) => ({ name: m.name }));
  return { partials, orphans: [] as { path: string; size: number }[], missing };
}

export async function gcApply() {
  const { partials, missing } = await gcScan();
  for (const p of partials) {
    const parent = p.path.split("/").slice(0, -1).join("/");
    await (await dirFor(parent, false)).removeEntry(p.path.split("/").pop()!).catch(() => {});
  }
  for (const m of missing) await removeModel(m.name).catch(() => {});
  return { removed: partials.length + missing.length };
}
