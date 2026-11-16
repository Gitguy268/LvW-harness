import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "../config.ts";
import { ensureDirs } from "../paths.ts";
import { findFile, installRelease } from "../runtime/ghrelease.ts";
import type { InstalledMedia } from "./store.ts";

/**
 * Music with audio.cpp (Apache-2.0, github.com/0xShug0/audio.cpp), used for Yue2-3B.
 * Pinned release; GitHub publishes a sha256 for every asset.
 */
export const AUDIOCPP_REPO = "0xShug0/audio.cpp";
export const AUDIOCPP_TAG = "v0.9.5";

const root = () => join(ensureDirs().runtime, "audio.cpp");

export function audioCppPattern(os = platform(), cpu = arch()): RegExp {
  if (os === "darwin") return cpu === "arm64" ? /-bin-macos-arm64-metal\.tar\.gz$/ : /-bin-macos-x64-metal\.tar\.gz$/;
  if (os === "linux" && cpu === "x64") return /-bin-ubuntu-x64-cpu\.tar\.gz$/;
  throw new Error(`audio.cpp ${AUDIOCPP_TAG} has no build for ${os}/${cpu}. Build it yourself and set media.audiocpp in the config.`);
}

export function findAudioCpp(): string | undefined {
  const own = loadConfig().media.audiocpp;
  if (own && existsSync(own)) return own;
  return findFile(join(root(), AUDIOCPP_TAG), "audiocpp_cli") ?? Bun.which("audiocpp_cli") ?? undefined;
}

export async function installAudioCpp(onProgress?: (done: number, total?: number) => void): Promise<string> {
  const have = findAudioCpp();
  if (have) return have;
  const dir = await installRelease({ repo: AUDIOCPP_REPO, tag: AUDIOCPP_TAG, pattern: audioCppPattern(), root: root(), executables: ["audiocpp_cli", "audiocpp_server", "audiocpp_gguf"], onProgress });
  if (platform() === "darwin") Bun.spawnSync(["xattr", "-dr", "com.apple.quarantine", dir]);
  const bin = findAudioCpp();
  if (!bin) throw new Error(`The audio.cpp download has no audiocpp_cli.`);
  return bin;
}

/** The arguments audio.cpp's Yue2 model card uses for direct (cot=off) generation. */
export function yue2Args(m: InstalledMedia, req: { prompt: string; lyrics?: string; seed?: number; steps?: number }, out: string, backend: string, threads: number): string[] {
  const modelFile = m.files.model;
  const vaeFile = m.files.vae;
  if (!modelFile || !vaeFile) throw new Error(`${m.entry.name} is missing its model or VAE file. Pull it again.`);
  // Yue2 sings lyrics; without any, the prompt becomes a single verse.
  const text = req.lyrics?.trim() || `[Verse]\n${req.prompt.trim()}`;
  return [
    "--task", "gen",
    "--family", "yue2",
    "--model", join(modelFile, ".."),
    "--backend", backend,
    "--threads", String(threads),
    "--text", text,
    "--request-option", `style=${req.prompt.trim()}`,
    "--request-option", "cot=off",
    "--request-option", `seed=${req.seed ?? Math.floor(Math.random() * 2 ** 31)}`,
    "--request-option", `num_inference_steps=${req.steps ?? m.entry.defaults?.steps ?? 8}`,
    "--session-option", `yue2.model_gguf=${basename(modelFile)}`,
    "--session-option", `yue2.vae_gguf=${basename(vaeFile)}`,
    "--out", out,
  ];
}

/** Text (plus optional lyrics) → WAV bytes. One CLI run per song. */
export async function makeYue2(m: InstalledMedia, req: { prompt: string; lyrics?: string; seed?: number; steps?: number }, opts: { signal?: AbortSignal; onStatus?: (s: string) => void } = {}): Promise<Uint8Array> {
  const bin = findAudioCpp();
  if (!bin) throw new Error("audio.cpp isn't installed. Run `lvw media install music`.");
  const dir = mkdtempSync(join(tmpdir(), "lvw-yue2-"));
  const out = join(dir, "song.wav");
  const backend = platform() === "darwin" ? "metal" : "cpu";
  const threads = Math.max(2, Math.min(8, navigator.hardwareConcurrency - 1));
  try {
    opts.onStatus?.("Composing with Yue2 (this takes a while)…");
    const proc = Bun.spawn([bin, ...yue2Args(m, req, out, backend, threads)], { stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    opts.signal?.addEventListener("abort", kill);
    const started = Date.now();
    const tick = setInterval(() => opts.onStatus?.(`Composing with Yue2… ${Math.round((Date.now() - started) / 1000)} s`), 2000);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited, new Response(proc.stdout).text()]);
    clearInterval(tick);
    opts.signal?.removeEventListener("abort", kill);
    if (opts.signal?.aborted) throw new Error("Cancelled.");
    if (code !== 0 || !existsSync(out)) throw new Error(`audio.cpp failed (exit ${code}):\n${stderr.trim().split("\n").slice(-10).join("\n")}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
