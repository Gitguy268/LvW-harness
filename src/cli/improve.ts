import { parseArgs } from "node:util";
import { resolveChatModel } from "../core/providers.ts";
import { shutdownTools } from "../core/session.ts";
import { improve, listProfiles, removeProfile, saveProfile, STRATEGIES } from "../orchestra/improve.ts";
import { c, fail, table } from "./ui.ts";

export async function improveCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: "string" }, model: { type: "string", short: "m" }, cwd: { type: "string" }, "max-turns": { type: "string" } },
  });
  const [first, ...rest] = positionals;
  if (first === "ls") {
    const profiles = listProfiles();
    if (!profiles.length) return console.log(c.dim('No profiles yet. lvw improve "<task>" --name <profile>'));
    return table(
      profiles.map((p) => [c.bold(p.name), p.strategy, p.model, p.task.slice(0, 60)]),
      ["profile", "strategy", "model", "tuned on"],
    );
  }
  if (first === "rm") {
    if (!rest[0]) fail("lvw improve rm <profile>");
    removeProfile(rest[0]);
    return console.log(`removed profile ${rest[0]}`);
  }
  const task = positionals.join(" ");
  if (!task) fail('lvw improve "<task>" [--name profile] [--model m]   (experimental) | lvw improve ls | rm <profile>');

  const resolved = await resolveChatModel(values.model, (s) => console.error(c.dim(s)));
  const cwd = values.cwd ?? process.cwd();
  console.error(c.yellow("experimental: ") + `trying ${STRATEGIES.length} strategies with ${resolved.label}, each in a scratch copy of ${cwd} with --auto permissions.`);
  try {
    const results = await improve({
      task,
      cwd,
      resolved,
      maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
      onProbe: (s, copied) => console.error(c.cyan(`● ${s}`) + (copied ? "" : c.dim(" (folder over 50 MB: started from an empty folder)"))),
    });
    table(
      results.map((r) => [c.bold(r.strategy), r.error ? c.red("error") : String(r.score), String(r.toolCalls), String(r.tokens), (r.error ?? r.reason).slice(0, 70)]),
      ["strategy", "score", "tools", "tokens", "why"],
    );
    const best = results[0];
    if (!best || best.error) fail("No strategy finished; nothing saved.");
    const name = values.name ?? "improved";
    saveProfile({
      name,
      strategy: best.strategy,
      prompt: best.prompt,
      task,
      model: resolved.model.id,
      scores: results.map((r) => ({ strategy: r.strategy, score: r.score, tokens: r.tokens, toolCalls: r.toolCalls })),
      created_at: Date.now(),
    });
    console.log(`\nSaved profile ${c.bold(name)} (${best.strategy}). Use it: lvw run --profile ${name} "<task>"`);
  } finally {
    await shutdownTools();
  }
}
