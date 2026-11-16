import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gitCheckpoints } from "../core/checkpoints-git.ts";
import { recipeTemplate, renderRecipe } from "../core/recipes.ts";
import { findRecipe, listRecipes, loadSubRecipe, recipeDirs, removeRecipe, saveRecipe } from "../core/recipes-fs.ts";
import { c, fail, table } from "./ui.ts";

const params = (list: string[] = []) =>
  Object.fromEntries(
    list.map((p) => {
      const i = p.indexOf("=");
      if (i < 1) fail(`--param needs key=value, got "${p}"`);
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );

/** lvw recipe ls | show <name> | new <name> [--project] | add <file> [--project] | rm <name> | run <name> [--param k=v]… */
export async function recipeCommand(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { param: { type: "string", multiple: true, short: "p" }, project: { type: "boolean" }, cwd: { type: "string" }, model: { type: "string" }, auto: { type: "boolean" }, yes: { type: "boolean", short: "y" }, json: { type: "boolean" } },
  });
  const cwd = resolve(values.cwd ?? process.cwd());
  const scope = values.project ? "project" : "user";
  switch (cmd) {
    case "ls":
    case undefined: {
      const list = listRecipes(cwd);
      if (values.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) return console.log(c.dim(`No recipes yet. Make one with ${c.bold("lvw recipe new <name>")} (saved in ${recipeDirs(cwd).user}).`));
      return table(list.map((r) => [r.error ? c.red("broken") : c.green(r.scope), c.bold(r.name), r.error ?? r.recipe?.description ?? "", r.recipe?.mode ?? ""]), ["", "name", "description", "mode"]);
    }
    case "show": {
      const r = findRecipe(positionals[0] ?? fail("lvw recipe show <name>"), cwd);
      return console.log(readFileSync(r.path, "utf8"));
    }
    case "new": {
      const name = positionals[0] ?? fail("lvw recipe new <name>");
      const dir = recipeDirs(cwd)[scope];
      const path = join(dir, `${name}.yaml`);
      if (existsSync(path)) fail(`${path} already exists.`);
      return console.log(`${c.green("created")} ${saveRecipe(recipeTemplate(name), cwd, scope)}  ${c.dim("edit it, then: lvw recipe run " + name)}`);
    }
    case "add": {
      const file = positionals[0] ?? fail("lvw recipe add <file.yaml>");
      return console.log(`${c.green("saved")} ${saveRecipe(readFileSync(file, "utf8"), cwd, scope)}`);
    }
    case "rm":
      return console.log(`${c.green("removed")} ${removeRecipe(positionals[0] ?? fail("lvw recipe rm <name>"), cwd)}`);
    case "run": {
      const file = findRecipe(positionals[0] ?? fail("lvw recipe run <name> [--param key=value]"), cwd);
      const recipe = file.recipe!;
      let prompt = renderRecipe(recipe, params(values.param));
      if (recipe.sub_recipes?.length) {
        const subs = recipe.sub_recipes.map((s) => {
          const sub = loadSubRecipe(file, s.path);
          return `- ${s.name}: ${sub.description ?? ""}\n  Task for a subagent: ${renderRecipe(sub, s.values ?? {}).replace(/\n/g, " ")}`;
        });
        prompt += `\n\nSub-recipes you can hand to the subagent tool when they fit:\n${subs.join("\n")}`;
      }
      const { runCommand } = await import("./run.ts");
      const args = [prompt, "--cwd", cwd, ...(recipe.mode ? ["--mode", recipe.mode] : []), ...(values.model ?? recipe.model ? ["--model", (values.model ?? recipe.model)!] : []), ...(values.auto || values.yes ? ["--yes"] : []), ...(values.json ? ["--json"] : [])];
      return runCommand(args);
    }
    default:
      fail("lvw recipe ls | show <name> | new <name> | add <file> | rm <name> | run <name> [--param k=v]");
  }
}

/** lvw checkpoints [--cwd dir]   ·   lvw undo [id] [--cwd dir] */
export async function checkpointCommand(argv: string[], undo = false) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { cwd: { type: "string" }, diff: { type: "boolean" } } });
  const cwd = resolve(values.cwd ?? process.cwd());
  const store = gitCheckpoints(cwd) ?? fail("Checkpoints don't work here (a home folder, the disk root, or git is missing).");
  const list = await store.list(50);
  if (!undo) {
    if (!list.length) return console.log(c.dim("No checkpoints for this folder yet. LvW takes one before the agent's first change in each turn."));
    if (values.diff && positionals[0]) {
      const hit = list.find((cp) => cp.id.startsWith(positionals[0])) ?? fail(`No checkpoint ${positionals[0]}.`);
      return console.log(await store.diff(hit.id));
    }
    return table(list.map((cp) => [c.cyan(cp.id.slice(0, 8)), c.dim(new Date(cp.time).toLocaleString()), cp.label]), ["id", "when", "before"]);
  }
  const target = positionals[0] ? list.find((cp) => cp.id.startsWith(positionals[0])) : list.find((cp) => !cp.label.startsWith("before restoring"));
  if (!target) fail(positionals[0] ? `No checkpoint ${positionals[0]}. See lvw checkpoints.` : "Nothing to undo in this folder.");
  const r = await store.restore(target.id);
  console.log(`${c.green("restored")} ${target.id.slice(0, 8)} "${target.label}": ${r.restored} files back, ${r.removed} removed.`);
  console.log(c.dim("Changed your mind? The state before this restore is the newest checkpoint: lvw checkpoints, then lvw undo <id>."));
}

