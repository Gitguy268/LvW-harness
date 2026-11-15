import { existsSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ensureDirs } from "../paths.ts";
import { findFile } from "../runtime/ghrelease.ts";
import { startProc, stopProc } from "../runtime/proc.ts";

/**
 * Speech to text with whisper.cpp's `whisper-server` (MIT). whisper.cpp publishes no macOS or
 * Linux binaries, so it comes from Homebrew (`whisper.cpp`) or a pinned source build.
 * Models are whisper.cpp's own ggml files (some repos name them .gguf, like oxide-lab's
 * whisper.cpp/ folder); Candle-style GGUF Whisper files don't load here.
 */
export const WHISPER_TAG = "v1.9.5";
const PROC = "whisper-server";

const buildRoot = () => join(ensureDirs().runtime, "whisper.cpp");

export function findWhisperServer(): string | undefined {
  const own = loadConfig().media.whisperServer;
  if (own && existsSync(own)) return own;
  const built = findFile(join(buildRoot(), WHISPER_TAG, "build", "bin"), "whisper-server");
  if (built) return built;
  return Bun.which("whisper-server") ?? (existsSync("/opt/homebrew/bin/whisper-server") ? "/opt/homebrew/bin/whisper-server" : undefined);
}

async function run(argv: string[], onLine?: (s: string) => void, cwd?: string) {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  let tail = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) {
      const text = new TextDecoder().decode(chunk);
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim().slice(0, 160));
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  if ((await proc.exited) !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed:\n${tail.split("\n").slice(-10).join("\n")}`);
}

/** Homebrew on macOS when it's there, else a pinned source build (needs git, cmake and a C++ compiler). */
export async function installWhisper(onLine?: (s: string) => void): Promise<string> {
  const have = findWhisperServer();
  if (have) return have;
  const brew = Bun.which("brew");
  if (platform() === "darwin" && brew) {
    onLine?.("Installing whisper.cpp with Homebrew…");
    await run([brew, "install", "whisper.cpp"], onLine);
  } else {
    for (const tool of ["git", "cmake"]) if (!Bun.which(tool)) throw new Error(`Building whisper.cpp needs ${tool}. Install it, or install whisper-server yourself and set media.whisperServer in the config.`);
    const dir = join(buildRoot(), WHISPER_TAG);
    mkdirSync(buildRoot(), { recursive: true });
    if (!existsSync(join(dir, "CMakeLists.txt"))) {
      onLine?.(`Downloading whisper.cpp ${WHISPER_TAG}…`);
      await run(["git", "clone", "--depth", "1", "--branch", WHISPER_TAG, "https://github.com/ggml-org/whisper.cpp.git", dir], onLine);
    }
    onLine?.("Building whisper-server (a few minutes)…");
    await run(["cmake", "-S", dir, "-B", join(dir, "build"), "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_TESTS=OFF"], onLine);
    await run(["cmake", "--build", join(dir, "build"), "--config", "Release", "--target", "whisper-server", "-j"], onLine);
  }
  const bin = findWhisperServer();
  if (!bin) throw new Error("whisper-server still isn't there after installing. Set media.whisperServer in the config to its path.");
  return bin;
}

export async function stopWhisper() {
  return stopProc(PROC);
}

/** 16 kHz mono WAV → text. Starts whisper-server with this model (or reuses it). */
export async function whisperTranscribe(model: string, wav: Uint8Array, opts: { language?: string; translate?: boolean; signal?: AbortSignal; onStatus?: (s: string) => void } = {}): Promise<string> {
  const bin = findWhisperServer();
  if (!bin) throw new Error("whisper-server isn't installed. Run `lvw media install transcribe`.");
  const port = loadConfig().media.whisperPort;
  const s = await startProc(PROC, {
    argv: [bin, "-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", String(Math.max(2, Math.min(8, navigator.hardwareConcurrency - 1)))],
    port,
    key: model,
    healthPath: "/health",
    label: "Whisper",
    onStatus: opts.onStatus,
    timeoutMs: 3 * 60_000,
  });
  opts.onStatus?.("Listening…");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("language", opts.language || "auto");
  if (opts.translate) form.append("translate", "true");
  const res = await fetch(`http://127.0.0.1:${s.port}/inference`, { method: "POST", body: form, signal: opts.signal });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok || body.error) throw new Error(`whisper-server: ${body.error ?? res.status}`);
  return (body.text ?? "").trim();
}
