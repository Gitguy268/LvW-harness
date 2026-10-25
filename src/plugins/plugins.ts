import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { paths } from "../paths.ts";
import type { LvwTool, ToolContext } from "../tools/tool.ts";

/**
 * Plugins, after deepseek-harness's "everything is a plugin": a folder in ~/.lvw/plugins with
 *   plugin.json   { "name": "...", "description": "...", "main": "index.ts", "enabled": true }
 *   index.ts      export function tools(ctx) { return [ ...LvwTool ] }
 *   skills/       optional; its SKILL.md folders show up like installed skills
 * The built-in browser and MCP tools are added the same way (see core/session.ts).
 */
export interface PluginManifest {
  name: string;
  description?: string;
  main?: string;
  enabled?: boolean;
}

export interface Plugin {
  dir: string;
  manifest: PluginManifest;
  error?: string;
}

export interface PluginModule {
  tools?: (ctx: ToolContext) => LvwTool[] | Promise<LvwTool[]>;
}

export function listPlugins(): Plugin[] {
  const root = paths().plugins;
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "plugin.json")))
    .map((e) => {
      const dir = join(root, e.name);
      try {
        return { dir, manifest: { name: e.name, ...JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")) } };
      } catch (err) {
        return { dir, manifest: { name: e.name, enabled: false }, error: `bad plugin.json: ${(err as Error).message}` };
      }
    });
}

/** Import every enabled plugin. A broken plugin is reported and skipped, never fatal. */
export async function loadPlugins(onError?: (name: string, err: Error) => void): Promise<{ name: string; mod: PluginModule }[]> {
  const out: { name: string; mod: PluginModule }[] = [];
  for (const p of listPlugins()) {
    if (p.error || p.manifest.enabled === false) continue;
    try {
      const mod = (await import(pathToFileURL(join(p.dir, p.manifest.main ?? "index.ts")).href)) as PluginModule;
      out.push({ name: p.manifest.name, mod });
    } catch (err) {
      onError?.(p.manifest.name, err as Error);
    }
  }
  return out;
}

/** skills/ folders shipped by enabled plugins. */
export function pluginSkillDirs(): string[] {
  return listPlugins()
    .filter((p) => !p.error && p.manifest.enabled !== false)
    .map((p) => join(p.dir, "skills"))
    .filter(existsSync);
}
