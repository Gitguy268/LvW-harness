import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { downloadFile } from "../models/download.ts";
import { modelPath } from "../models/manager.ts";
import { findModel, listModels, touchModel } from "../models/registry.ts";
import { isProjector } from "../models/select.ts";
import type { ModelRecord } from "../models/types.ts";
import { ensureDirs } from "../paths.ts";

const RELEASES = "https://github.com/ggml-org/llama.cpp/releases";

function llamaDir() {
  return join(ensureDirs().runtime, "llama.cpp");
}

/** Asset suffix for this machine. `variant` picks a GPU build on Linux, e.g. "vulkan" or "cuda-12.8". */
export function assetSuffix(variant?: string) {
  const a = arch() === "arm64" ? "arm64" : "x64";
  if (platform() === "darwin") return `bin-macos-${a}`;
  if (platform() === "linux") return variant ? `bin-ubuntu-${variant}-${a}` : `bin-ubuntu-${a}`;
  throw new Error(`No prebuilt llama.cpp for ${platform()}. Install llama-server yourself and set it on PATH.`);
}

/** The newest build tag (bNNNNN). Releases are tagged vX.Y.Z with a nightly-tag.txt pointing at the build. */
export async function latestBuildTag(): Promise<string> {
  const res = await fetch(`${RELEASES}/latest`, { redirect: "manual" });
  const tag = res.headers.get("location")?.split("/").pop();
  if (!tag) throw new Error("Couldn't find the latest llama.cpp release.");
  if (/^b\d+$/.test(tag)) return tag;
  const nightly = await fetch(`${RELEASES}/download/${tag}/nightly-tag.txt`);
  const text = (await nightly.text()).trim();
  if (!nightly.ok || !/^b\d+$/.test(text)) throw new Error(`llama.cpp release ${tag} has no build tag.`);
  return text;
}

export function installedBuilds(): string[] {
  const dir = llamaDir();
  return existsSync(dir) ? readdirSync(dir).filter((d) => /^b\d+$/.test(d)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))) : [];
}

function findIn(dir: string, name: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const hit = findIn(p, name);
      if (hit) return hit;
    }
  }
}

/** llama-server from config, then the newest LvW-installed build, then PATH. */
export function findLlamaServer(): string | undefined {
  const cfg = loadConfig();
  if (cfg.llama.binary && existsSync(cfg.llama.binary)) return cfg.llama.binary;
  for (const build of installedBuilds()) {
    const hit = findIn(join(llamaDir(), build), "llama-server");
    if (hit) return hit;
  }
  return Bun.which("llama-server") ?? undefined;
}

export async function installLlama(opts: { tag?: string; variant?: string; onProgress?: (done: number, total?: number) => void } = {}) {
  const tag = opts.tag ?? (await latestBuildTag());
  const asset = `llama-${tag}-${assetSuffix(opts.variant)}.tar.gz`;
  const dest = join(llamaDir(), tag);
  const archive = join(llamaDir(), asset);
  await downloadFile({ path: asset, url: `${RELEASES}/download/${tag}/${asset}` }, archive, { onProgress: opts.onProgress });
  mkdirSync(dest, { recursive: true });
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", dest]);
  rmSync(archive, { force: true });
  if (tar.exitCode !== 0) throw new Error(`Couldn't unpack ${asset}: ${tar.stderr.toString()}`);
  const server = findIn(dest, "llama-server");
  if (!server) throw new Error(`${asset} has no llama-server binary.`);
  // Keep only this build to save disk.
  for (const old of installedBuilds()) if (old !== tag) rmSync(join(llamaDir(), old), { recursive: true, force: true });
  return { tag, server };
}

export interface ServerState {
  pid: number;
  port: number;
  modelId: string;
  modelName: string;
  ctx: number;
  startedAt: number;
}

const stateFile = () => join(ensureDirs().runtime, "llama-server.json");

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function serverState(): ServerState | undefined {
  const f = stateFile();
  if (!existsSync(f)) return undefined;
  const s = JSON.parse(readFileSync(f, "utf8")) as ServerState;
  if (alive(s.pid)) return s;
  rmSync(f, { force: true });
  return undefined;
}

export async function serverHealthy(port = loadConfig().llama.port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export async function stopServer() {
  const s = serverState();
  if (!s) return false;
  process.kill(s.pid, "SIGTERM");
  for (let i = 0; i < 50 && alive(s.pid); i++) await Bun.sleep(100);
  if (alive(s.pid)) process.kill(s.pid, "SIGKILL");
  rmSync(stateFile(), { force: true });
  return true;
}

/** Start llama-server for a registry model in the background. Reuses a server already running that model. */
export async function startServer(ref: string | ModelRecord, opts: { ctx?: number; onStatus?: (s: string) => void } = {}): Promise<ServerState> {
  const m = typeof ref === "string" ? findModel(ref) : ref;
  if (!m) throw new Error(`No model "${ref}". See \`lvw model ls\`.`);
  if (!m.mainFile) throw new Error(`${m.name} is ${m.format}, which llama.cpp can't run. Pull a GGUF build of it.`);
  const cfg = loadConfig();
  const ctx = opts.ctx ?? cfg.llama.ctx;
  const running = serverState();
  if (running?.modelId === m.id && running.ctx === ctx && (await serverHealthy(running.port))) return running;
  if (running) await stopServer();

  const bin = findLlamaServer();
  if (!bin) throw new Error("llama-server isn't installed. Run `lvw runtime install`.");
  const args = ["-m", modelPath(m), "--host", "127.0.0.1", "--port", String(cfg.llama.port), "-c", String(ctx), "--jinja", "--alias", m.name];
  const projector = m.files.find(isProjector);
  if (projector) args.push("--mmproj", modelPath(m, projector));
  args.push(...cfg.llama.args);

  const log = join(ensureDirs().logs, "llama-server.log");
  const fd = openSync(log, "w");
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  const state: ServerState = { pid: child.pid!, port: cfg.llama.port, modelId: m.id, modelName: m.name, ctx, startedAt: Date.now() };
  writeFileSync(stateFile(), JSON.stringify(state));
  opts.onStatus?.(`Loading ${m.name}…`);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!alive(state.pid)) {
      rmSync(stateFile(), { force: true });
      const tail = readFileSync(log, "utf8").split("\n").slice(-15).join("\n");
      throw new Error(`llama-server exited while loading ${m.name}. Last log lines:\n${tail}`);
    }
    if (await serverHealthy(state.port)) {
      touchModel(m.id);
      return state;
    }
    await Bun.sleep(300);
  }
  await stopServer();
  throw new Error(`llama-server didn't become ready within 3 minutes. See ${log}.`);
}

export function runtimeInfo() {
  const bin = findLlamaServer();
  return {
    llamaServer: bin,
    builds: installedBuilds(),
    size: bin ? statSync(bin).size : 0,
    running: serverState(),
    models: listModels().length,
  };
}
