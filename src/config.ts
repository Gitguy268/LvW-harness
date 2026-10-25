import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDirs } from "./paths.ts";

export type PermissionMode = "ask" | "auto" | "readonly";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface Config {
  /** Default model: a registry name, "local", "ollama:<name>" or "<provider>:<model-id>". */
  model?: string;
  permissions: PermissionMode;
  sandbox: "host" | "docker";
  sandboxImage: string;
  sandboxNetwork: "none" | "bridge";
  server: { host: string; port: number; token?: string };
  llama: { port: number; ctx: number; args: string[]; binary?: string };
  ollamaUrl: string;
  /** Refuse downloads that would leave less than this much free disk. */
  minFreeGB: number;
  searxngUrl?: string;
  browser: { executablePath?: string; cdpUrl?: string; headless: boolean };
  budgets: { maxTurns: number; maxTokens: number };
  mcpServers: Record<string, McpServerConfig>;
  telegram: { allowedChatIds: number[] };
}

export const DEFAULTS: Config = {
  permissions: "ask",
  sandbox: "host",
  sandboxImage: "debian:stable-slim",
  sandboxNetwork: "none",
  server: { host: "127.0.0.1", port: 7878 },
  llama: { port: 7879, ctx: 8192, args: [] },
  ollamaUrl: process.env.OLLAMA_HOST ? normalizeOllama(process.env.OLLAMA_HOST) : "http://127.0.0.1:11434",
  minFreeGB: 2,
  browser: { headless: true },
  budgets: { maxTurns: 40, maxTokens: 400_000 },
  mcpServers: {},
  telegram: { allowedChatIds: [] },
};

function normalizeOllama(host: string) {
  return host.startsWith("http") ? host : `http://${host}`;
}

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

export function loadConfig(): Config {
  const p = ensureDirs();
  if (!existsSync(p.config)) return structuredClone(DEFAULTS);
  return merge(structuredClone(DEFAULTS), JSON.parse(readFileSync(p.config, "utf8")));
}

export function saveConfig(cfg: Config) {
  const p = ensureDirs();
  writeFileSync(p.config, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** Set a dotted key, e.g. `server.port`, parsing JSON values where possible. */
export function setConfigValue(key: string, raw: string) {
  const cfg = loadConfig() as unknown as Record<string, unknown>;
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {}
  const parts = key.split(".");
  let node = cfg;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
  saveConfig(cfg as unknown as Config);
}
