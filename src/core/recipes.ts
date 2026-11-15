/**
 * Recipes: shareable YAML files that package a prompt with its mode, model, skills and
 * parameters, plus sub-recipes the agent can call (after Goose's recipes). Browser-safe: the
 * caller passes the YAML parser (Bun.YAML natively, the `yaml` package in the web UI).
 *
 *   name: release-notes
 *   description: Draft release notes from the git log
 *   mode: code
 *   parameters:
 *     - key: since
 *       description: Tag to start from
 *       default: v0.1.0
 *   prompt: |
 *     Write release notes for everything since {{since}}.
 *   sub_recipes:
 *     - name: changelog-check
 *       path: changelog-check.yaml
 */
import type { AgentMode } from "../config.ts";
import { isMode } from "./modes.ts";

export interface RecipeParam {
  key: string;
  description?: string;
  default?: string;
  required?: boolean;
}

export interface Recipe {
  name: string;
  description?: string;
  prompt: string;
  mode?: AgentMode;
  model?: string;
  skills?: string[];
  parameters?: RecipeParam[];
  sub_recipes?: { name: string; path: string; values?: Record<string, string> }[];
}

export type YamlParse = (text: string) => unknown;

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

/** Read and check a recipe. Throws with a plain message on anything wrong. */
export function parseRecipe(text: string, parse: YamlParse): Recipe {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`The recipe isn't valid YAML: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object") throw new Error("A recipe is a YAML mapping with at least name and prompt.");
  const r = raw as Record<string, unknown>;
  const name = str(r.name)?.trim();
  const prompt = str(r.prompt ?? r.instructions)?.trim();
  if (!name || !/^[\w.-]{1,64}$/.test(name)) throw new Error("A recipe needs a name of letters, digits, dots, dashes or underscores.");
  if (!prompt) throw new Error(`Recipe ${name} has no prompt.`);
  if (r.mode !== undefined && !isMode(r.mode)) throw new Error(`Recipe ${name}: unknown mode "${r.mode}".`);
  const params = Array.isArray(r.parameters) ? r.parameters : [];
  const parameters: RecipeParam[] = params.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const key = str(o.key)?.trim();
    if (!key || !/^[\w.-]+$/.test(key)) throw new Error(`Recipe ${name}: parameter ${i + 1} needs a key.`);
    return { key, description: str(o.description), default: str(o.default), required: o.required === true || (o.requirement ?? "") === "required" };
  });
  const subs = Array.isArray(r.sub_recipes) ? r.sub_recipes : [];
  return {
    name,
    description: str(r.description),
    prompt,
    mode: r.mode as AgentMode | undefined,
    model: str(r.model),
    skills: Array.isArray(r.skills) ? r.skills.map(String) : undefined,
    parameters,
    sub_recipes: subs.map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const n = str(o.name);
      const p = str(o.path);
      if (!n || !p) throw new Error(`Recipe ${name}: every sub-recipe needs a name and a path.`);
      return { name: n, path: p, values: o.values && typeof o.values === "object" ? Object.fromEntries(Object.entries(o.values).map(([k, v]) => [k, String(v)])) : undefined };
    }),
  };
}

/** Fill {{param}} placeholders. Missing required values throw; defaults fill the rest. */
export function renderRecipe(r: Recipe, values: Record<string, string> = {}): string {
  const all: Record<string, string> = {};
  for (const p of r.parameters ?? []) {
    const v = values[p.key] ?? p.default;
    if (v === undefined && p.required !== false) throw new Error(`Recipe ${r.name} needs a value for "${p.key}"${p.description ? ` (${p.description})` : ""}. Pass --param ${p.key}=…`);
    all[p.key] = v ?? "";
  }
  for (const [k, v] of Object.entries(values)) all[k] ??= v;
  let prompt = r.prompt.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => (k in all ? all[k] : m));
  if (r.skills?.length) prompt = `Load and follow these skills first: ${r.skills.join(", ")}.\n\n${prompt}`;
  return prompt;
}

/** A starter recipe for `lvw recipe new`. */
export function recipeTemplate(name: string): string {
  return `name: ${name}
description: What this recipe does, in one line
mode: code
parameters:
  - key: target
    description: What to work on
    default: .
prompt: |
  Describe the task here. Use {{target}} for parameters.
`;
}
