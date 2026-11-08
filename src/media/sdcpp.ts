import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { downloadFile } from "../models/download.ts";
import { ensureDirs } from "../paths.ts";
import type { MediaEntry } from "./catalog.ts";
import type { InstalledMedia } from "./store.ts";

/**
 * leejet/stable-diffusion.cpp (MIT): one `sd-server` runs image and video models.
 * Pinned to a release whose assets GitHub publishes sha256 digests for.
 */
export const SD_TAG = "master-1058-7bcd4ce";
const REPO = "leejet/stable-diffusion.cpp";

const sdDir = () => join(ensureDirs().runtime, "sd.cpp");
const exe = (name: string) => (platform() === "win32" ? `${name}.exe` : name);

/** Which release asset fits this machine. `variant` picks a GPU build: vulkan, rocm (Linux), cuda12 (Windows). */
export function sdAssetPattern(os = platform(), cpu = arch(), variant?: string): RegExp {
  if (os === "darwin") return /bin-Darwin-macOS-[\d.]+-arm64\.zip$/; // a universal binary: arm64 and x86_64
  if (os === "linux" && cpu === "x64") return variant ? new RegExp(`bin-Linux-Ubuntu-[\\d.]+-x86_64-${variant}[\\w.-]*\\.zip$`) : /bin-Linux-Ubuntu-[\d.]+-x86_64\.zip$/;
  if (os === "win32" && cpu === "x64") return new RegExp(`bin-win-${variant ?? "cpu"}[\\w.-]*-x64\\.zip$`);
  throw new Error(`stable-diffusion.cpp has no prebuilt server for ${os}-${cpu}. Build sd-server from source and set media.sdServer, or set up a media API (see \`lvw media\`).`);
}

function findIn(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const hit = findIn(p, name);
      if (hit) return hit;
    }
  }
}

/** media.sdServer from config, then the installed build, then PATH. */
export function findSdServer(): string | undefined {
  const cfg = loadConfig();
  if (cfg.media.sdServer && existsSync(cfg.media.sdServer)) return cfg.media.sdServer;
  return findIn(sdDir(), exe("sd-server")) ?? Bun.which("sd-server") ?? undefined;
}

interface GhAsset {
  name: string;
  size: number;
  digest?: string;
  browser_download_url: string;
}

async function unzip(archive: string, dest: string) {
  const tries: string[][] = [];
  if (Bun.which("unzip")) tries.push(["unzip", "-q", "-o", archive, "-d", dest]);
  tries.push(["tar", "-xf", archive, "-C", dest]); // bsdtar on macOS and Windows reads zip
  if (Bun.which("python3")) tries.push(["python3", "-m", "zipfile", "-e", archive, dest]);
  for (const argv of tries) if (Bun.spawnSync(argv).exitCode === 0) return;
  throw new Error(`Couldn't unpack ${archive}. Install unzip and try again.`);
}

export async function installSd(opts: { variant?: string; onProgress?: (done: number, total?: number) => void } = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${SD_TAG}`, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for stable-diffusion.cpp ${SD_TAG}.`);
  const assets = ((await res.json()) as { assets: GhAsset[] }).assets;
  const pattern = sdAssetPattern(platform(), arch(), opts.variant);
  const asset = assets.find((a) => pattern.test(a.name));
  if (!asset) throw new Error(`stable-diffusion.cpp ${SD_TAG} has no asset matching ${pattern}.`);
  const sha256 = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined;
  if (!sha256) throw new Error(`GitHub gave no checksum for ${asset.name}; refusing to install it.`);
  const root = sdDir();
  const dest = join(root, SD_TAG);
  const archive = join(root, asset.name);
  await downloadFile({ path: asset.name, url: asset.browser_download_url, size: asset.size, sha256 }, archive, { onProgress: opts.onProgress });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  try {
    await unzip(archive, dest);
  } finally {
    rmSync(archive, { force: true });
  }
  const server = findIn(dest, exe("sd-server"));
  if (!server) throw new Error(`${asset.name} has no sd-server.`);
  if (platform() !== "win32") chmodSync(server, 0o755);
  for (const old of readdirSync(root)) if (old !== SD_TAG) rmSync(join(root, old), { recursive: true, force: true });
  return { tag: SD_TAG, server, asset: asset.name };
}

export function removeSd() {
  rmSync(sdDir(), { recursive: true, force: true });
}

interface SdState {
  pid: number;
  port: number;
  modelId: string;
  startedAt: number;
}

const stateFile = () => join(ensureDirs().runtime, "sd-server.json");
const logFile = () => join(ensureDirs().logs, "sd-server.log");

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sdState(): SdState | undefined {
  if (!existsSync(stateFile())) return undefined;
  const s = JSON.parse(readFileSync(stateFile(), "utf8")) as SdState;
  if (alive(s.pid)) return s;
  rmSync(stateFile(), { force: true });
  return undefined;
}

async function healthy(port: number) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export async function stopSd() {
  const s = sdState();
  if (!s) return false;
  process.kill(s.pid, "SIGTERM");
  for (let i = 0; i < 50 && alive(s.pid); i++) await Bun.sleep(100);
  if (alive(s.pid)) process.kill(s.pid, "SIGKILL");
  rmSync(stateFile(), { force: true });
  return true;
}

export function sdArgs(m: InstalledMedia, port: number): string[] {
  const args = ["--listen-ip", "127.0.0.1", "--listen-port", String(port)];
  for (const [flag, file] of Object.entries(m.files)) args.push(flag === "model" ? "-m" : `--${flag}`, file);
  return [...args, ...(m.entry.args ?? []), ...loadConfig().media.sdArgs];
}

/** Start sd-server with a model, or reuse the one already running it. Loading big models takes minutes. */
export async function startSd(m: InstalledMedia, onStatus?: (s: string) => void): Promise<SdState> {
  const port = loadConfig().media.sdPort;
  const running = sdState();
  if (running?.modelId === m.id && (await healthy(running.port))) return running;
  if (running) await stopSd();
  const bin = findSdServer();
  if (!bin) throw new Error("sd-server isn't installed. Run `lvw media install image`.");
  const fd = openSync(logFile(), "w");
  const child = spawn(bin, sdArgs(m, port), { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  const state: SdState = { pid: child.pid!, port, modelId: m.id, startedAt: Date.now() };
  writeFileSync(stateFile(), JSON.stringify(state));
  onStatus?.(`Loading ${m.entry.name}…`);
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (!alive(state.pid)) {
      rmSync(stateFile(), { force: true });
      const tail = readFileSync(logFile(), "utf8").split("\n").slice(-15).join("\n");
      throw new Error(`sd-server exited while loading ${m.entry.name}. Last log lines:\n${tail}`);
    }
    if (await healthy(port)) return state;
    await Bun.sleep(500);
  }
  await stopSd();
  throw new Error(`sd-server didn't become ready in 15 minutes. See ${logFile()}.`);
}

export interface SdRequest {
  prompt: string;
  negative?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  /** Image to start from (img2img, image-to-video): base64 or data URL. */
  initImage?: string;
  strength?: number;
  frames?: number;
  fps?: number;
}

export interface SdProgress {
  status: string;
  step?: number;
  total?: number;
  /** PNG preview of the current step, base64. */
  preview?: string;
}

interface Job {
  status: "queued" | "generating" | "completed" | "failed" | "cancelled";
  queue_position?: number;
  preview?: { step: number; total_steps: number; b64_json: string } | null;
  result?: { images?: { b64_json: string }[]; b64_json?: string; mime_type?: string; output_format?: string; fps?: number; frame_count?: number } | null;
  error?: { message?: string } | string | null;
}

/** The native async API body for img_gen or vid_gen, filled from the request and the model's defaults. */
export function sdBody(kind: "image" | "video", req: SdRequest, entry: MediaEntry) {
  const d = entry.defaults ?? {};
  const sample: Record<string, unknown> = { sample_steps: req.steps ?? d.steps ?? 20, guidance: { txt_cfg: req.cfg ?? d.cfg ?? 7 } };
  if (d.sampler) sample.sample_method = d.sampler;
  if (d.flowShift) sample.flow_shift = d.flowShift;
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    negative_prompt: req.negative ?? d.negative ?? "",
    width: req.width ?? d.width ?? 512,
    height: req.height ?? d.height ?? 512,
    seed: req.seed ?? -1,
    sample_params: sample,
    preview: "proj",
    preview_interval: 1,
  };
  if (req.initImage) {
    body.init_image = req.initImage;
    body.strength = req.strength ?? 0.75;
  }
  if (kind === "image") Object.assign(body, { batch_count: 1, output_format: "png" });
  else Object.assign(body, { video_frames: req.frames ?? d.frames ?? 17, fps: req.fps ?? d.fps ?? 16, output_format: "webm" });
  return body;
}

/** Submit a job and poll it until it finishes. Returns the encoded file and its mime type. */
export async function sdGenerate(kind: "image" | "video", req: SdRequest, state: SdState, entry: MediaEntry, opts: { signal?: AbortSignal; onProgress?: (p: SdProgress) => void } = {}) {
  const base = `http://127.0.0.1:${state.port}/sdcpp/v1`;
  const submit = await fetch(`${base}/${kind === "image" ? "img_gen" : "vid_gen"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sdBody(kind, req, entry)) });
  if (!submit.ok) throw new Error(`sd-server refused the job (${submit.status}): ${(await submit.text()).slice(0, 300)}`);
  const { id } = (await submit.json()) as { id: string };
  const cancel = () => void fetch(`${base}/jobs/${id}/cancel`, { method: "POST" }).catch(() => {});
  opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error("Cancelled.");
      const res = await fetch(`${base}/jobs/${id}`);
      if (!res.ok) throw new Error(`sd-server lost job ${id} (${res.status}).`);
      const job = (await res.json()) as Job;
      if (job.status === "completed") {
        const r = job.result ?? {};
        const b64 = kind === "image" ? r.images?.[0]?.b64_json : r.b64_json;
        if (!b64) throw new Error("sd-server finished without a result.");
        return { data: Buffer.from(b64, "base64"), mime: kind === "image" ? "image/png" : (r.mime_type ?? "video/webm"), frames: r.frame_count, fps: r.fps };
      }
      if (job.status === "failed" || job.status === "cancelled") {
        const msg = typeof job.error === "string" ? job.error : job.error?.message;
        throw new Error(`Generation ${job.status}${msg ? `: ${msg}` : ""}. See ${logFile()}.`);
      }
      opts.onProgress?.({
        status: job.status === "queued" ? `queued (${job.queue_position ?? 0} ahead)` : "generating",
        step: job.preview?.step,
        total: job.preview?.total_steps,
        preview: job.preview?.b64_json,
      });
      await Bun.sleep(700);
    }
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
  }
}
