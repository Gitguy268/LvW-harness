import { existsSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { getToken } from "../credentials.ts";
import { paths } from "../paths.ts";
import { findFile, installRelease } from "../runtime/ghrelease.ts";
import { startProc, stopProc } from "../runtime/proc.ts";
import { objToGlb } from "./obj2glb.ts";

/**
 * Picture → 3D with idol.cpp (Apache-2.0, github.com/TimeLordRaps/idol.cpp) and Idol-GGUF.
 * Its native decoders are x86-64 only (Apple Silicon runs them through Rosetta 2, macOS 15+).
 * Idol also needs two gated image encoders (DINOv3 and the FLUX.2-dev autoencoder): accept
 * their terms on Hugging Face and log in with `lvw login hf`.
 */
export const IDOL_REPO = "TimeLordRaps/idol.cpp";
export const IDOL_TAG = "v0.1.1";
/** Gated repos Idol reads at start, with a small file in each that only an approved login can fetch. */
export const IDOL_GATED: Record<string, string> = {
  "facebook/dinov3-vith16plus-pretrain-lvd1689m": "config.json",
  "black-forest-labs/FLUX.2-dev": "model_index.json",
};
const PROC = "idol";

const root = () => join(paths().home, "sidecars", "idol");
const pkgDir = () => {
  const run = findFile(join(root(), IDOL_TAG), "run.sh");
  return run ? join(run, "..") : undefined;
};
export const idolInstalled = () => existsSync(join(root(), "ready")) && Boolean(pkgDir());

export function idolPattern(os = platform(), cpu = arch()): RegExp {
  if (os === "darwin") return /^idol-v[\d.]+-macos-x64\.tar\.gz$/;
  if (os === "linux" && cpu === "x64") return /^idol-v[\d.]+-linux-x64\.tar\.gz$/;
  throw new Error(`idol.cpp ${IDOL_TAG} has no package for ${os}/${cpu} (it needs an x86-64 CPU, or Rosetta 2 on a Mac).`);
}

function env(): Record<string, string> {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), HF_HOME: join(root(), "hf"), PYTORCH_ENABLE_MPS_FALLBACK: "1" };
  const token = getToken("hf");
  if (token) e.HF_TOKEN = token;
  return e;
}

async function run(argv: string[], cwd: string, onLine?: (s: string) => void, extraPath?: string) {
  const e = env();
  if (extraPath) e.PATH = `${extraPath}:${e.PATH ?? ""}`;
  const proc = Bun.spawn(argv, { cwd, env: e, stdout: "pipe", stderr: "pipe" });
  let tail = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) {
      const text = new TextDecoder().decode(chunk);
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim().slice(0, 160));
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  if ((await proc.exited) !== 0) throw new Error(`${argv.slice(0, 2).join(" ")} failed:\n${tail.split("\n").slice(-12).join("\n")}`);
}

/** Can this Hugging Face login read both gated encoders? Returns the ones it can't. */
export async function idolMissingAccess(): Promise<string[]> {
  const token = getToken("hf");
  const missing: string[] = [];
  for (const [repo, file] of Object.entries(IDOL_GATED)) {
    const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`, { method: "HEAD", redirect: "manual", headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => undefined);
    if (!res || res.status >= 400) missing.push(repo);
  }
  return missing;
}

export function idolAccessHelp(missing: string[]) {
  return `Idol needs two gated image encoders. Accept their terms on Hugging Face (${missing.map((r) => `https://huggingface.co/${r}`).join(" and ")}), then run \`lvw login hf\` with a token that can read them. TripoSR (\`lvw media pull triposr\`) works without that.`;
}

export async function installIdol(onLine?: (s: string) => void) {
  const uv = Bun.which("uv");
  if (!uv) throw new Error("idol.cpp's Python packages are installed with uv. Install it first: https://docs.astral.sh/uv/");
  rmSync(join(root(), "ready"), { force: true });
  onLine?.(`Downloading idol.cpp ${IDOL_TAG}…`);
  await installRelease({ repo: IDOL_REPO, tag: IDOL_TAG, pattern: idolPattern(), root: root(), executables: ["run.sh", "setup.sh", "idol_mesh", "idol_decode", "idol_octree_compare"] });
  const dir = pkgDir();
  if (!dir) throw new Error("The idol.cpp package has no run.sh.");
  if (platform() === "darwin") Bun.spawnSync(["xattr", "-dr", "com.apple.quarantine", dir]);
  for (const b of ["bin/idol_mesh", "bin/idol_decode", "bin/idol_octree_compare"]) if (existsSync(join(dir, b))) Bun.spawnSync(["chmod", "+x", join(dir, b)]);
  // setup.sh wants Python 3.10+ with pip; a seeded uv venv gives it one and it reuses .venv.
  await run([uv, "venv", "--seed", "--allow-existing", "--python", "3.11", ".venv"], dir, onLine);
  onLine?.("Installing PyTorch and idol.cpp's packages (a few GB)…");
  await run(["bash", "setup.sh"], dir, onLine, join(dir, ".venv", "bin"));
  writeFileSync(join(root(), "ready"), new Date().toISOString());
}

export function removeIdol() {
  rmSync(root(), { recursive: true, force: true });
}

export async function stopIdol() {
  return stopProc(PROC);
}

/** One picture → GLB (plus the Gaussian point cloud as PLY). */
export async function makeIdol(model: string, image: Uint8Array, opts: { seed?: number; steps?: number; signal?: AbortSignal; onStatus?: (s: string) => void } = {}) {
  const dir = pkgDir();
  if (!idolInstalled() || !dir) throw new Error("idol.cpp isn't installed. Run `lvw media install 3d`.");
  const missing = await idolMissingAccess();
  if (missing.length) throw new Error(idolAccessHelp(missing));
  const port = loadConfig().media.idolPort;
  const device = platform() === "linux" && Bun.which("nvidia-smi") ? "cuda" : "cpu";
  const s = await startProc(PROC, {
    argv: [join(dir, ".venv", "bin", "python"), "tools/idol_server.py", "--model", model, "--port", String(port), "--device", device, "--output-dir", join(root(), "outputs")],
    cwd: dir,
    env: env(),
    port,
    key: model,
    healthPath: "/health",
    label: "Idol",
    onStatus: opts.onStatus,
    timeoutMs: 15 * 60_000,
  });
  const base = `http://127.0.0.1:${s.port}`;
  opts.onStatus?.(`Reconstructing with Idol on the ${device.toUpperCase()} (slow without an NVIDIA GPU)…`);
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image)], { type: "image/png" }), "input.png");
  form.append("mode", "real");
  form.append("seed", String(opts.seed ?? 42));
  form.append("steps", String(opts.steps ?? 50));
  const res = await fetch(`${base}/v1/reconstructions`, { method: "POST", body: form, signal: opts.signal });
  if (!res.ok) throw new Error(`Idol: ${((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? res.status}`);
  const ply = new Uint8Array(await res.arrayBuffer());
  const id = /\/v1\/reconstructions\/([^/]+)\/metadata/.exec(res.headers.get("x-idol-metadata") ?? "")?.[1];
  if (!id) throw new Error("Idol returned no result id.");
  opts.onStatus?.("Extracting the mesh…");
  const mesh = await fetch(`${base}/v1/reconstructions/${encodeURIComponent(id)}/mesh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: opts.signal });
  if (!mesh.ok) throw new Error(`Idol mesh: ${((await mesh.json().catch(() => ({}))) as { detail?: string }).detail ?? mesh.status}`);
  return { glb: objToGlb(await mesh.text()), ply };
}
