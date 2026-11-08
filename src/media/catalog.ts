import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { paths } from "../paths.ts";
import builtin from "./catalog.json" with { type: "json" };

/**
 * What LvW can make. `listen` is a chat model that hears audio; `transcribe` is speech to text;
 * `speech` is text to speech.
 */
export type MediaKind = "image" | "video" | "speech" | "transcribe" | "listen" | "music" | "3d";
export const MEDIA_KINDS: MediaKind[] = ["image", "video", "speech", "transcribe", "listen", "music", "3d"];
export type Engine = "sdcpp" | "ollama" | "triposr" | "acestep";

export interface MediaDefaults {
  steps?: number;
  cfg?: number;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  flowShift?: number;
  sampler?: string;
  negative?: string;
}

export interface MediaEntry {
  id: string;
  kinds: MediaKind[];
  engine: Engine;
  name: string;
  licence: string;
  sizeGB: number;
  ramGB: number;
  default?: boolean;
  note?: string;
  /** sd-server flag name (without --) → "hf:owner/repo/path/in/repo". */
  components?: Record<string, string>;
  /** Ollama model name for engine "ollama". */
  ollama?: string;
  args?: string[];
  /** Extra args per process.platform, e.g. {"darwin": ["--backend", "diffusion=cpu"]}. */
  platformArgs?: Partial<Record<NodeJS.Platform, string[]>>;
  defaults?: MediaDefaults;
}

/** Built-in entries plus any in ~/.lvw/media-catalog.json (same shape), which win on id. */
export function catalog(): MediaEntry[] {
  const own = join(paths().home, "media-catalog.json");
  const extra: MediaEntry[] = existsSync(own) ? ((JSON.parse(readFileSync(own, "utf8")) as { entries?: MediaEntry[] }).entries ?? []) : [];
  const byId = new Map<string, MediaEntry>();
  for (const e of [...(builtin.entries as MediaEntry[]), ...extra]) byId.set(e.id, e);
  return [...byId.values()];
}

export function findEntry(id: string): MediaEntry | undefined {
  return catalog().find((e) => e.id === id);
}

/** The configured default for a kind, else the catalog default. */
export function defaultEntry(kind: MediaKind): MediaEntry | undefined {
  const chosen = loadConfig().media.defaults[kind];
  const list = catalog().filter((e) => e.kinds.includes(kind));
  return (chosen && list.find((e) => e.id === chosen)) || list.find((e) => e.default) || list[0];
}

/** "hf:owner/repo/dir/file.gguf" → repo and path. */
export function parseComponent(spec: string): { repo: string; path: string } {
  const m = /^hf:([^/]+\/[^/]+)\/(.+)$/.exec(spec);
  if (!m) throw new Error(`Component "${spec}" must look like hf:owner/repo/path/to/file`);
  return { repo: m[1], path: m[2] };
}
