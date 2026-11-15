import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { parseRecipe, type Recipe } from "./recipes.ts";

/** Recipes live in ./.lvw/recipes (this project, wins on name) and ~/.lvw/recipes (everywhere). */
export const recipeDirs = (cwd: string) => ({ project: join(cwd, ".lvw", "recipes"), user: join(paths().home, "recipes") });

export interface RecipeFile {
  name: string;
  scope: "project" | "user";
  path: string;
  recipe?: Recipe;
  error?: string;
}

const yaml = (t: string) => Bun.YAML.parse(t);

export function listRecipes(cwd: string): RecipeFile[] {
  const out = new Map<string, RecipeFile>();
  const dirs = recipeDirs(cwd);
  for (const scope of ["user", "project"] as const) {
    const dir = dirs[scope];
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
      const path = join(dir, f);
      const name = f.replace(/\.ya?ml$/, "");
      try {
        const recipe = parseRecipe(readFileSync(path, "utf8"), yaml);
        out.set(recipe.name, { name: recipe.name, scope, path, recipe });
      } catch (err) {
        out.set(name, { name, scope, path, error: (err as Error).message });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findRecipe(name: string, cwd: string): RecipeFile {
  const hit = listRecipes(cwd).find((r) => r.name === name);
  if (!hit) throw new Error(`No recipe "${name}". See \`lvw recipe ls\`.`);
  if (hit.error) throw new Error(`Recipe ${name} (${hit.path}): ${hit.error}`);
  return hit;
}

/** Save recipe YAML after checking it. Returns the path. */
export function saveRecipe(text: string, cwd: string, scope: "project" | "user" = "user"): string {
  const recipe = parseRecipe(text, yaml);
  const dir = recipeDirs(cwd)[scope];
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${recipe.name}.yaml`);
  writeFileSync(path, text.endsWith("\n") ? text : text + "\n");
  return path;
}

export function removeRecipe(name: string, cwd: string): string {
  const hit = listRecipes(cwd).find((r) => r.name === name);
  if (!hit) throw new Error(`No recipe "${name}".`);
  rmSync(hit.path, { force: true });
  return hit.path;
}

/** A sub-recipe's path is relative to the recipe that names it. */
export function loadSubRecipe(parent: RecipeFile, rel: string): Recipe {
  const p = join(parent.path, "..", rel);
  if (!existsSync(p)) throw new Error(`Sub-recipe ${rel} not found next to ${parent.path}.`);
  return parseRecipe(readFileSync(p, "utf8"), yaml);
}
