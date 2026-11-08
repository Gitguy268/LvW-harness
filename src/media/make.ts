import { loadConfig } from "../config.ts";
import { getToken } from "../credentials.ts";
import { formatBytes, freeBytes } from "../models/disk.ts";
import { downloadFile } from "../models/download.ts";
import { listHfFiles } from "../models/hf.ts";
import { paths } from "../paths.ts";
import { ollamaAvailable, ollamaList, ollamaOpenAiUrl, ollamaPull, ollamaRemove } from "../runtime/ollama.ts";
import { openAiImage, replicate, speech, toWav, transcribe, type OpenAiTarget } from "./api.ts";
import { catalog, defaultEntry, findEntry, parseComponent, type MediaEntry, type MediaKind } from "./catalog.ts";
import { findSdServer, sdGenerate, startSd, type SdProgress } from "./sdcpp.ts";
import { make3d, makeMusic, sidecarInstalled } from "./sidecar.ts";
import { extOf, installedMedia, listInstalledMedia, mediaModelDir, removeInstalled, saveInstalled, saveOutput, type MediaOutput } from "./store.ts";

export interface MakeRequest {
  kind: Exclude<MediaKind, "listen">;
  /** Text to draw, film, say, compose, or turn into 3D. */
  prompt?: string;
  /** Input picture (image editing, image-to-video, image-to-3D). */
  image?: Uint8Array;
  /** Input audio (transcription). */
  audio?: Uint8Array;
  /** Catalog id, or "api" to force the hosted fallback. */
  model?: string;
  negative?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  frames?: number;
  voice?: string;
  language?: string;
  translate?: boolean;
  lyrics?: string;
  seconds?: number;
}

export interface MakeProgress {
  status: string;
  step?: number;
  total?: number;
  preview?: string;
}

export interface MakeOptions {
  signal?: AbortSignal;
  onProgress?: (p: MakeProgress) => void;
}

const openAi = (): OpenAiTarget | undefined => {
  const key = getToken("openai");
  const baseUrl = loadConfig().media.api.openai?.baseUrl ?? (key ? "https://api.openai.com/v1" : undefined);
  return baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, ""), key } : undefined;
};

/** Is a local engine ready for this entry? */
export async function entryReady(e: MediaEntry): Promise<boolean> {
  if (e.engine === "sdcpp") return Boolean(installedMedia(e.id) && findSdServer());
  if (e.engine === "ollama") return (await ollamaAvailable()) && (await ollamaList()).some((m) => m.name === e.ollama || m.name === `${e.ollama}:latest`);
  return sidecarInstalled(e.engine === "triposr" ? "3d" : "music");
}

/** Pick the local entry to use, or undefined when the kind should go to an API. */
async function pick(kind: MediaKind, model?: string): Promise<MediaEntry | undefined> {
  if (model === "api") return undefined;
  if (model) {
    const e = findEntry(model);
    if (!e) throw new Error(`No media model "${model}". See \`lvw media ls\`.`);
    if (!e.kinds.includes(kind)) throw new Error(`${e.name} can't do ${kind}; it does ${e.kinds.join(", ")}.`);
    return e;
  }
  const preferred = defaultEntry(kind);
  if (preferred && (await entryReady(preferred))) return preferred;
  for (const e of catalog().filter((x) => x.kinds.includes(kind))) if (await entryReady(e)) return e;
  return undefined;
}

function noEngine(kind: MediaKind): Error {
  const e = defaultEntry(kind);
  const how = e ? `Run \`lvw media pull ${e.id}\`` : "Add a model for it";
  return new Error(`Nothing is set up to make ${kind}. ${how}, or add a hosted fallback (\`lvw login openai\` / \`lvw login replicate\` and media.api in the config).`);
}

const sdProgress = (cb?: (p: MakeProgress) => void) => (p: SdProgress) => cb?.({ status: p.status, step: p.step, total: p.total, preview: p.preview });

/** Make one piece of media and save it under ~/.lvw/media. */
export async function make(req: MakeRequest, opts: MakeOptions = {}): Promise<MediaOutput> {
  const say = (status: string) => opts.onProgress?.({ status });
  const kind = req.kind;
  if ((kind === "image" || kind === "video" || kind === "speech" || kind === "music") && !req.prompt?.trim()) throw new Error(`Making ${kind} needs a prompt.`);
  if (kind === "transcribe" && !req.audio) throw new Error("Transcription needs audio.");

  // Text to 3D: draw the object first, then lift it.
  if (kind === "3d" && !req.image) {
    if (!req.prompt?.trim()) throw new Error("3D needs a picture or a prompt.");
    say("Drawing the object first…");
    const pic = await make({ kind: "image", prompt: `${req.prompt}, a single object, centered, whole object in view, plain light grey background, studio lighting`, seed: req.seed, width: 768, height: 768 }, opts);
    const glb = await make({ ...req, image: new Uint8Array(await Bun.file(pic.path).arrayBuffer()) }, opts);
    glb.meta.sourceImage = pic.rel;
    return glb;
  }

  const entry = await pick(kind, req.model);
  const meta: Record<string, unknown> = { prompt: req.prompt, model: entry?.id ?? "api", seed: req.seed };

  if (kind === "image" || kind === "video") {
    if (entry) {
      const m = installedMedia(entry.id);
      if (!m) throw new Error(`${entry.name} isn't downloaded. Run \`lvw media pull ${entry.id}\`.`);
      const state = await startSd(m, say);
      const initImage = req.image ? Buffer.from(req.image).toString("base64") : undefined;
      const r = await sdGenerate(kind, { ...req, prompt: req.prompt!, initImage }, state, entry, { signal: opts.signal, onProgress: sdProgress(opts.onProgress) });
      Object.assign(meta, { width: req.width ?? entry.defaults?.width, height: req.height ?? entry.defaults?.height, steps: req.steps ?? entry.defaults?.steps, frames: r.frames, fps: r.fps });
      return saveOutput(kind, r.data, extOf(r.mime), meta);
    }
    const api = loadConfig().media.api;
    if (kind === "image" && openAi() && api.openai?.image) {
      say("Asking the image API…");
      const data = await openAiImage(openAi()!, { model: api.openai.image, prompt: req.prompt!, width: req.width, height: req.height }, opts.signal);
      return saveOutput(kind, data, ".png", { ...meta, model: `api:${api.openai.image}` });
    }
    return viaReplicate(kind, req, meta, opts) ?? Promise.reject(noEngine(kind));
  }

  if (kind === "speech" || kind === "transcribe") {
    const api = loadConfig().media.api.openai;
    const local = entry ? { target: { baseUrl: ollamaOpenAiUrl() }, model: entry.ollama! } : undefined;
    const remoteModel = kind === "speech" ? api?.speech : api?.transcribe;
    const use = local ?? (openAi() && remoteModel ? { target: openAi()!, model: remoteModel } : undefined);
    if (!use) throw noEngine(kind);
    meta.model = local ? entry!.id : `api:${remoteModel}`;
    if (kind === "speech") {
      say("Speaking…");
      const wav = await speech(use.target, { model: use.model, input: req.prompt!, voice: req.voice ?? (local ? undefined : api?.voice) }, opts.signal);
      return saveOutput("speech", wav, ".wav", { ...meta, voice: req.voice });
    }
    say("Listening…");
    const audio = local ? await toWav(req.audio!) : req.audio!;
    const text = await transcribe(use.target, { model: use.model, audio, language: req.language, translate: req.translate }, opts.signal);
    return saveOutput("transcribe", new TextEncoder().encode(text), ".txt", { ...meta, language: req.language }, text);
  }

  if (kind === "3d") {
    if (entry) {
      const glb = await make3d(req.image!, { signal: opts.signal, onStatus: say });
      return saveOutput("3d", glb, ".glb", meta);
    }
    return viaReplicate(kind, req, meta, opts) ?? Promise.reject(noEngine(kind));
  }

  if (kind === "music") {
    if (entry) {
      const wav = await makeMusic({ prompt: req.prompt!, lyrics: req.lyrics, seconds: req.seconds, seed: req.seed }, { signal: opts.signal, onStatus: say });
      return saveOutput("music", wav, ".wav", { ...meta, seconds: req.seconds ?? 30, lyrics: req.lyrics });
    }
    return viaReplicate(kind, req, meta, opts) ?? Promise.reject(noEngine(kind));
  }
  throw new Error(`Unknown kind ${kind}`);
}

function viaReplicate(kind: "image" | "video" | "music" | "3d", req: MakeRequest, meta: Record<string, unknown>, opts: MakeOptions): Promise<MediaOutput> | undefined {
  const token = getToken("replicate");
  const model = loadConfig().media.api.replicate?.[kind];
  if (!token || !model) return undefined;
  const input: Record<string, unknown> = {};
  if (req.prompt) input.prompt = req.prompt;
  if (req.image) input.image = `data:image/png;base64,${Buffer.from(req.image).toString("base64")}`;
  if (req.seconds) input.duration = req.seconds;
  return replicate(token, model, input, { signal: opts.signal, onStatus: (s) => opts.onProgress?.({ status: s }) }).then((r) =>
    saveOutput(kind, r.data, extOf(r.mime) === ".bin" ? { image: ".png", video: ".mp4", music: ".mp3", "3d": ".glb" }[kind] : extOf(r.mime), { ...meta, model: `replicate:${model}` }),
  );
}

export type PullEvent = { type: "status"; text: string } | { type: "progress"; file: string; done: number; total: number };

/** Download a catalog entry: component files for sd.cpp, an Ollama pull for audio, or the sidecar for 3D and music. */
export async function pullMedia(id: string, opts: { signal?: AbortSignal; onEvent?: (e: PullEvent) => void } = {}) {
  const e = findEntry(id);
  if (!e) throw new Error(`No media model "${id}". See \`lvw media ls\`.`);
  const say = (text: string) => opts.onEvent?.({ type: "status", text });
  if (e.engine === "ollama") {
    if (!(await ollamaAvailable())) throw new Error(`${e.name} runs in Ollama, which isn't running at ${loadConfig().ollamaUrl}.`);
    await ollamaPull(e.ollama!, (status, done, total) => (done && total ? opts.onEvent?.({ type: "progress", file: e.ollama!, done, total }) : say(status)), opts.signal);
    return e;
  }
  if (e.engine === "triposr" || e.engine === "acestep") {
    const { installSidecar } = await import("./sidecar.ts");
    await installSidecar(e.engine === "triposr" ? "3d" : "music", say);
    return e;
  }
  const dir = mediaModelDir(e.id);
  const files: Record<string, string> = {};
  const plan: { flag: string; file: Awaited<ReturnType<typeof listHfFiles>>[number] }[] = [];
  for (const [flag, spec] of Object.entries(e.components ?? {})) {
    const { repo, path } = parseComponent(spec);
    say(`Looking up ${repo}…`);
    const file = (await listHfFiles(repo, "main")).find((f) => f.path === path);
    if (!file) throw new Error(`${repo} has no file ${path}.`);
    plan.push({ flag, file });
  }
  const need = plan.reduce((n, p) => n + (p.file.size ?? 0), 0);
  const free = freeBytes(paths().mediaModels);
  const keep = loadConfig().minFreeGB * 1024 ** 3;
  if (need > free - keep) throw new Error(`${e.name} needs ${formatBytes(need)} but only ${formatBytes(free)} is free (keeping ${loadConfig().minFreeGB} GB spare).`);
  for (const { flag, file } of plan) {
    const name = file.path.split("/").pop()!;
    const dest = `${dir}/${name}`;
    await downloadFile(file, dest, { signal: opts.signal, onProgress: (done, total) => opts.onEvent?.({ type: "progress", file: name, done, total: total ?? file.size ?? 0 }) });
    files[flag] = dest;
  }
  saveInstalled(e, files, need);
  return e;
}

export async function removeMedia(id: string) {
  const e = findEntry(id);
  if (e?.engine === "ollama") {
    await ollamaRemove(e.ollama!);
    return true;
  }
  if (e?.engine === "triposr" || e?.engine === "acestep") {
    const { removeSidecar, stopSidecar } = await import("./sidecar.ts");
    const name = e.engine === "triposr" ? "3d" : "music";
    await stopSidecar(name);
    removeSidecar(name);
    return true;
  }
  const { sdState, stopSd } = await import("./sdcpp.ts");
  if (sdState()?.modelId === id) await stopSd();
  return removeInstalled(id);
}

export interface MediaRow extends MediaEntry {
  ready: boolean;
}

/** The catalog with what is ready on this machine. */
export async function mediaStatus(): Promise<MediaRow[]> {
  const installed = new Set(listInstalledMedia().map((m) => m.id));
  const ollama = (await ollamaAvailable()) ? (await ollamaList()).map((m) => m.name.replace(/:latest$/, "")) : [];
  return catalog().map((e) => ({
    ...e,
    ready: e.engine === "sdcpp" ? installed.has(e.id) : e.engine === "ollama" ? ollama.includes(e.ollama!) : sidecarInstalled(e.engine === "triposr" ? "3d" : "music"),
  }));
}
