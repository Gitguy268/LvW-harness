import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { downloadFile } from "../models/download.ts";
import { ensureDirs, paths } from "../paths.ts";
import media3dPy from "./sidecar/media3d.py" with { type: "text" };

/**
 * Python engines that run in their own uv-made venv under ~/.lvw/sidecars/<name>:
 *   3d    TripoSR (MIT) through our media3d.py, picture → GLB
 *   music ACE-Step 1.5 (MIT code and weights) through its own acestep-api server
 */
export type SidecarName = "3d" | "music";

export const TRIPOSR_COMMIT = "107cefdc244c39106fa830359024f6a2f1c78871";
export const ACESTEP_TAG = "v0.1.8";

const dirOf = (name: SidecarName) => join(paths().home, "sidecars", name);
const bin = (venv: string, name: string) => (platform() === "win32" ? join(venv, "Scripts", `${name}.exe`) : join(venv, "bin", name));
const portOf = (name: SidecarName) => (name === "3d" ? loadConfig().media.threeDPort : loadConfig().media.musicPort);

export function sidecarEnv(name: SidecarName, offline = false): Record<string, string> {
  const dir = dirOf(name);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HF_HOME: join(dir, "hf"),
    U2NET_HOME: join(dir, "u2net"),
    UV_PYTHON_INSTALL_DIR: join(paths().home, "sidecars", "python"),
    UV_LINK_MODE: "copy",
    ACESTEP_PROJECT_ROOT: join(dir, "ace"),
    PYTORCH_ENABLE_MPS_FALLBACK: "1",
  };
  if (offline) Object.assign(env, { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
  return env;
}

function uvPath() {
  const uv = Bun.which("uv");
  if (!uv) throw new Error("The 3D and music engines are installed with uv. Install it first: https://docs.astral.sh/uv/");
  return uv;
}

async function run(argv: string[], opts: { cwd?: string; env: Record<string, string>; onLine?: (s: string) => void }) {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" });
  let tail = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      const text = new TextDecoder().decode(chunk);
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onLine?.(line.trim().slice(0, 160));
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  if ((await proc.exited) !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed:\n${tail.split("\n").slice(-12).join("\n")}`);
}

async function fetchSource(url: string, dest: string, strip: string) {
  const tgz = `${dest}.tar.gz`;
  await downloadFile({ path: url, url }, tgz);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", dest, "--strip-components=1"]);
  rmSync(tgz, { force: true });
  if (tar.exitCode !== 0) throw new Error(`Couldn't unpack ${strip}: ${tar.stderr.toString()}`);
}

export const sidecarInstalled = (name: SidecarName) => existsSync(join(dirOf(name), "ready"));

export async function installSidecar(name: SidecarName, onLine?: (s: string) => void) {
  const uv = uvPath();
  const dir = dirOf(name);
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "ready"), { force: true });
  const env = sidecarEnv(name);
  if (name === "3d") {
    onLine?.("Downloading TripoSR…");
    await fetchSource(`https://codeload.github.com/VAST-AI-Research/TripoSR/tar.gz/${TRIPOSR_COMMIT}`, join(dir, "triposr"), "TripoSR");
    writeFileSync(join(dir, "media3d.py"), media3dPy);
    await run([uv, "venv", "--allow-existing", "--python", "3.11", join(dir, "venv")], { env, onLine });
    const py = bin(join(dir, "venv"), "python");
    onLine?.("Installing PyTorch and TripoSR's packages (a few GB)…");
    await run(
      [uv, "pip", "install", "--python", py, "torch", "omegaconf==2.3.0", "einops", "transformers>=4.40,<4.50", "trimesh", "rembg", "onnxruntime", "huggingface-hub", "PyMCubes", "Pillow", "imageio", "numpy<2.3"],
      { env, onLine },
    );
    onLine?.("Downloading the TripoSR and background-removal weights…");
    await run([py, "-c", "from huggingface_hub import hf_hub_download as d; d('stabilityai/TripoSR','config.yaml'); d('stabilityai/TripoSR','model.ckpt'); d('facebook/dino-vitb16','config.json'); import rembg; rembg.new_session()"], {
      env,
      onLine,
    });
  } else {
    onLine?.("Downloading ACE-Step 1.5…");
    await fetchSource(`https://codeload.github.com/ace-step/ACE-Step-1.5/tar.gz/refs/tags/${ACESTEP_TAG}`, join(dir, "ace"), "ACE-Step");
    onLine?.("Installing ACE-Step's packages (several GB)…");
    await run([uv, "sync", "--python", "3.12"], { cwd: join(dir, "ace"), env, onLine });
    onLine?.("Downloading the ACE-Step weights…");
    await run([uv, "run", "--no-sync", "acestep-download"], { cwd: join(dir, "ace"), env, onLine });
  }
  writeFileSync(join(dir, "ready"), new Date().toISOString());
}

export function removeSidecar(name: SidecarName) {
  rmSync(dirOf(name), { recursive: true, force: true });
}

interface SidecarState {
  pid: number;
  port: number;
}
const stateFile = (name: SidecarName) => join(ensureDirs().runtime, `sidecar-${name}.json`);
const logFile = (name: SidecarName) => join(ensureDirs().logs, `sidecar-${name}.log`);

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sidecarState(name: SidecarName): SidecarState | undefined {
  if (!existsSync(stateFile(name))) return undefined;
  const s = JSON.parse(readFileSync(stateFile(name), "utf8")) as SidecarState;
  if (alive(s.pid)) return s;
  rmSync(stateFile(name), { force: true });
}

async function healthy(port: number) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export async function stopSidecar(name: SidecarName) {
  const s = sidecarState(name);
  if (!s) return false;
  process.kill(s.pid, "SIGTERM");
  for (let i = 0; i < 50 && alive(s.pid); i++) await Bun.sleep(100);
  if (alive(s.pid)) process.kill(s.pid, "SIGKILL");
  rmSync(stateFile(name), { force: true });
  return true;
}

/** Start a sidecar (or reuse it) and wait until its model is loaded. */
export async function startSidecar(name: SidecarName, onStatus?: (s: string) => void): Promise<SidecarState> {
  const running = sidecarState(name);
  if (running && (await healthy(running.port))) return running;
  if (running) await stopSidecar(name);
  if (!sidecarInstalled(name)) throw new Error(`The ${name} engine isn't installed. Run \`lvw media install ${name}\`.`);
  const dir = dirOf(name);
  const port = portOf(name);
  const env = sidecarEnv(name, true);
  const argv =
    name === "3d"
      ? [bin(join(dir, "venv"), "python"), join(dir, "media3d.py"), "--port", String(port), "--tsr", join(dir, "triposr")]
      : [uvPath(), "run", "--no-sync", "acestep-api", "--host", "127.0.0.1", "--port", String(port)];
  const fd = openSync(logFile(name), "w");
  const child = spawn(argv[0], argv.slice(1), { cwd: name === "music" ? join(dir, "ace") : dir, env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  const state = { pid: child.pid!, port };
  writeFileSync(stateFile(name), JSON.stringify(state));
  onStatus?.(name === "3d" ? "Loading TripoSR…" : "Loading ACE-Step…");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (!alive(state.pid)) {
      rmSync(stateFile(name), { force: true });
      throw new Error(`The ${name} engine exited while loading. Last log lines:\n${readFileSync(logFile(name), "utf8").split("\n").slice(-15).join("\n")}`);
    }
    if (await healthy(port)) return state;
    await Bun.sleep(1000);
  }
  await stopSidecar(name);
  throw new Error(`The ${name} engine didn't start in 10 minutes. See ${logFile(name)}.`);
}

/** Picture → GLB bytes. */
export async function make3d(image: Uint8Array, opts: { removeBg?: boolean; resolution?: number; signal?: AbortSignal; onStatus?: (s: string) => void } = {}) {
  const s = await startSidecar("3d", opts.onStatus);
  opts.onStatus?.("Building the mesh…");
  const res = await fetch(`http://127.0.0.1:${s.port}/3d`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: Buffer.from(image).toString("base64"), remove_bg: opts.removeBg ?? true, resolution: opts.resolution ?? 256 }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`3D failed: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

interface AceEnvelope<T> {
  data: T;
  code?: number;
  error?: string | null;
}

/** Text (and optional lyrics) → WAV bytes through ACE-Step's task API. */
export async function makeMusic(req: { prompt: string; lyrics?: string; seconds?: number; seed?: number }, opts: { signal?: AbortSignal; onStatus?: (s: string) => void } = {}) {
  const s = await startSidecar("music", opts.onStatus);
  const base = `http://127.0.0.1:${s.port}`;
  const post = async <T>(path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: opts.signal });
    const j = (await res.json().catch(() => ({}))) as AceEnvelope<T>;
    if (!res.ok || j.error) throw new Error(`ACE-Step: ${j.error ?? res.status}`);
    return j.data;
  };
  const task = await post<{ task_id: string }>("/release_task", {
    prompt: req.prompt,
    lyrics: req.lyrics?.trim() || "[inst]",
    audio_duration: req.seconds ?? 30,
    audio_format: "wav",
    thinking: false,
    seed: req.seed ?? -1,
    batch_size: 1,
  });
  const started = Date.now();
  for (;;) {
    if (opts.signal?.aborted) throw new Error("Cancelled.");
    const [r] = await post<{ status: number; result?: string }[]>("/query_result", { task_id_list: [task.task_id] });
    if (r?.status === 2) throw new Error(`ACE-Step failed: ${r.result ?? "no reason given"}`);
    if (r?.status === 1) {
      const files = JSON.parse(r.result ?? "[]") as { file: string }[];
      if (!files[0]?.file) throw new Error("ACE-Step returned no audio.");
      const audio = await fetch(base + files[0].file, { signal: opts.signal });
      if (!audio.ok) throw new Error(`ACE-Step audio download failed (${audio.status}).`);
      return new Uint8Array(await audio.arrayBuffer());
    }
    opts.onStatus?.(`Composing… ${Math.round((Date.now() - started) / 1000)} s`);
    await Bun.sleep(1500);
  }
}
