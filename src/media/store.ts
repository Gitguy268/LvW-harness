import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { paths } from "../paths.ts";
import type { MediaEntry, MediaKind } from "./catalog.ts";

export interface InstalledMedia {
  id: string;
  entry: MediaEntry;
  /** Component name → absolute file path. */
  files: Record<string, string>;
  size: number;
  addedAt: number;
}

const modelDir = (id: string) => join(paths().mediaModels, id.replace(/[^\w.-]/g, "_"));

export function installedMedia(id: string): InstalledMedia | undefined {
  const f = join(modelDir(id), "model.json");
  if (!existsSync(f)) return undefined;
  const m = JSON.parse(readFileSync(f, "utf8")) as InstalledMedia;
  // Paths are stored relative so a moved LVW_HOME still works.
  for (const k of Object.keys(m.files)) m.files[k] = join(modelDir(id), m.files[k]);
  return Object.values(m.files).every((p) => existsSync(p)) ? m : undefined;
}

export function listInstalledMedia(): InstalledMedia[] {
  const root = paths().mediaModels;
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => {
      try {
        return JSON.parse(readFileSync(join(root, d, "model.json"), "utf8")).id as string;
      } catch {
        return undefined;
      }
    })
    .filter((id): id is string => Boolean(id))
    .map(installedMedia)
    .filter((m): m is InstalledMedia => Boolean(m));
}

export function mediaModelDir(id: string) {
  const d = modelDir(id);
  mkdirSync(d, { recursive: true });
  return d;
}

export function saveInstalled(entry: MediaEntry, files: Record<string, string>, size: number) {
  const dir = mediaModelDir(entry.id);
  const rel = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, basename(p)]));
  writeFileSync(join(dir, "model.json"), JSON.stringify({ id: entry.id, entry, files: rel, size, addedAt: Date.now() }, null, 2));
}

export function removeInstalled(id: string) {
  const d = modelDir(id);
  if (!existsSync(d)) return false;
  rmSync(d, { recursive: true, force: true });
  return true;
}

export const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".glb": "model/gltf-binary",
  ".obj": "model/obj",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export const mimeOf = (p: string) => MIME[extname(p).toLowerCase()] ?? "application/octet-stream";
export const extOf = (mime: string) => Object.entries(MIME).find(([, m]) => m === mime.split(";")[0])?.[0] ?? ".bin";

export interface MediaOutput {
  kind: MediaKind;
  /** Absolute path. */
  path: string;
  /** Path relative to the media folder, used in /media/<rel> URLs. */
  rel: string;
  mime: string;
  /** Transcripts and other text results. */
  text?: string;
  meta: Record<string, unknown>;
}

/** Write a result to ~/.lvw/media/<date>/<kind>-<time>.<ext> with a .json beside it holding the settings. */
export function saveOutput(kind: MediaKind, data: Uint8Array, ext: string, meta: Record<string, unknown>, text?: string): MediaOutput {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(paths().media, day);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  let name = `${kind}-${stamp}${ext}`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${kind}-${stamp}-${i}${ext}`;
  const path = join(dir, name);
  writeFileSync(path, data);
  const out: MediaOutput = { kind, path, rel: `${day}/${name}`, mime: mimeOf(path), text, meta };
  writeFileSync(`${path}.json`, JSON.stringify({ kind, mime: out.mime, text, ...meta, createdAt: Date.now() }, null, 2));
  return out;
}

/** Newest results first, for the gallery. */
export function listOutputs(limit = 60): MediaOutput[] {
  const root = paths().media;
  if (!existsSync(root)) return [];
  const out: MediaOutput[] = [];
  for (const day of readdirSync(root).sort().reverse()) {
    const dir = join(root, day);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && existsSync(join(dir, f.slice(0, -5))));
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    for (const f of files) {
      const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const path = join(dir, f.slice(0, -5));
      out.push({ kind: meta.kind as MediaKind, path, rel: `${day}/${f.slice(0, -5)}`, mime: mimeOf(path), text: meta.text as string | undefined, meta });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Resolve a /media/<rel> path safely inside the media folder. */
export function mediaFile(rel: string): string | undefined {
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) return undefined;
  const p = join(paths().media, rel);
  return existsSync(p) && statSync(p).isFile() ? p : undefined;
}

export function removeOutput(rel: string) {
  const p = mediaFile(rel);
  if (!p) return false;
  rmSync(p, { force: true });
  rmSync(`${p}.json`, { force: true });
  return true;
}
