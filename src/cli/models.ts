import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "../config.ts";
import { fitFor, formatBytes } from "../models/disk.ts";
import { searchHf } from "../models/hf.ts";
import { diskUsage, gcApply, gcScan, listAll, pull, removeModel, resolveSpec } from "../models/manager.ts";
import { findModel } from "../models/registry.ts";
import { listChoices } from "../models/select.ts";
import { parseSpec } from "../models/source.ts";
import { serverState, startServer, stopServer } from "../runtime/llamacpp.ts";
import { ask, c, confirm, fail, progressBar, table } from "./ui.ts";

const FIT_COLOR = { fits: c.green, tight: c.yellow, "too big": c.red } as const;

export const MODEL_HELP = `lvw model <command>

  search <words>              search Hugging Face (most downloaded first)
  info <spec>                 list the files/quants a source offers, with size and RAM fit
  pull <spec> [--all] [--name n] [--yes]
                              download. spec: hf:owner/repo[:Q4_K_M] | gh:owner/repo[@tag][:glob]
                              | gl:group/project[@tag][:glob] | https://…/file.gguf | ollama:name
  ls                          list downloaded models (and Ollama's)
  rm <name>… [--keep-files]   remove models and their files
  du                          disk used by models and free space
  gc [--yes]                  delete unfinished downloads and stray files
  run <name> [--ctx n]        start llama-server with a model and make it the default
  stop                        stop llama-server
  use <name>                  set the default model without starting it`;

export async function modelCommand(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      name: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "keep-files": { type: "boolean" },
      ctx: { type: "string" },
      json: { type: "boolean" },
      limit: { type: "string" },
    },
  });
  switch (cmd) {
    case "search": {
      if (!positionals.length) fail("lvw model search <words>");
      const rows = await searchHf(positionals.join(" "), Number(values.limit ?? 20));
      if (values.json) return console.log(JSON.stringify(rows, null, 2));
      table(
        rows.map((r) => [c.bold(r.id), String(r.downloads), r.gguf ? c.green("gguf") : "", r.gated ? c.yellow("gated") : ""]),
        ["MODEL", "DOWNLOADS", "", ""],
      );
      console.log(c.dim("\nPull one with: lvw model pull hf:<model>"));
      return;
    }
    case "info": {
      const spec = positionals[0] ?? fail("lvw model info <spec>");
      const r = await resolveSpec(spec);
      const ctx = loadConfig().llama.ctx;
      const choices = listChoices(r.available);
      if (values.json) return console.log(JSON.stringify({ ...r, choices }, null, 2));
      console.log(c.bold(spec) + c.dim(`  →  ~/.lvw/models/${r.dir}`));
      if (r.note) console.log(c.dim(r.note));
      table(
        choices.map((ch) => {
          const fit = fitFor(ch.size, ctx).fit;
          const picked = r.selected.some((s) => s.path === ch.path || s.path.startsWith(ch.path.replace(/\.gguf$/i, "")));
          return [picked ? c.green("●") : " ", ch.pattern, ch.size ? formatBytes(ch.size) : "?", ch.parts > 1 ? `${ch.parts} parts` : "", ch.size ? FIT_COLOR[fit](fit) : ""];
        }),
        ["", "CHOICE", "SIZE", "", "RAM"],
      );
      return;
    }
    case "pull": {
      if (!positionals.length) fail("lvw model pull <spec>");
      for (const spec of positionals) await pullOne(spec, values);
      return;
    }
    case "ls":
    case "list": {
      const models = await listAll();
      const running = serverState();
      const def = loadConfig().model;
      if (values.json) return console.log(JSON.stringify(models, null, 2));
      if (!models.length) return console.log("No models yet. Try: lvw model pull hf:unsloth/Qwen3-4B-Instruct-2507-GGUF");
      table(
        models.map((m) => [
          (running?.modelId === m.id ? c.green("▶ ") : def === m.name ? c.cyan("★ ") : "  ") + c.bold(m.name),
          m.format,
          formatBytes(m.size),
          m.missing ? c.red("files missing") : m.runnable ? FIT_COLOR[m.fit](m.fit) : c.dim("not runnable"),
          c.dim(m.spec),
        ]),
        ["  NAME", "FORMAT", "SIZE", "STATUS", "SOURCE"],
      );
      console.log(c.dim(`\n▶ running  ★ default`));
      return;
    }
    case "rm":
    case "remove": {
      if (!positionals.length) fail("lvw model rm <name>…");
      for (const ref of positionals) {
        if (!values.yes && process.stdin.isTTY && !(await confirm(`Remove ${ref} and delete its files?`, true))) continue;
        const { name, freed } = await removeModel(ref, { keepFiles: values["keep-files"] });
        console.log(`${c.green("removed")} ${name}  ${c.dim(`freed ${formatBytes(freed)}`)}`);
        const cfg = loadConfig();
        if (cfg.model === name) {
          delete cfg.model;
          saveConfig(cfg);
        }
      }
      return;
    }
    case "du": {
      const d = diskUsage();
      table(d.models.map((m) => [m.name, formatBytes(m.size)]));
      console.log(`\n${c.bold("models")} ${formatBytes(d.used)}   ${c.bold("free disk")} ${formatBytes(d.free)}`);
      return;
    }
    case "gc": {
      const rep = gcScan();
      const items = [...rep.partials.map((p) => ["partial", p.path, formatBytes(p.size)]), ...rep.orphans.map((p) => ["stray", p.path, formatBytes(p.size)]), ...rep.missing.map((n) => ["missing files", n, ""])];
      if (!items.length) return console.log("Nothing to clean.");
      table(items);
      if (values.yes || (await confirm("Delete these?"))) console.log(`${c.green("freed")} ${formatBytes(gcApply(rep))}`);
      return;
    }
    case "run": {
      const name = positionals[0] ?? loadConfig().model ?? fail("lvw model run <name>");
      const s = await startServer(name, { ctx: values.ctx ? Number(values.ctx) : undefined, onStatus: (t) => console.log(c.dim(t)) });
      const cfg = loadConfig();
      cfg.model = s.modelName;
      saveConfig(cfg);
      console.log(`${c.green("running")} ${s.modelName} on http://127.0.0.1:${s.port}/v1 (OpenAI-compatible), context ${s.ctx}`);
      return;
    }
    case "stop":
      console.log((await stopServer()) ? "stopped llama-server" : "llama-server wasn't running");
      return;
    case "use": {
      const name = positionals[0] ?? fail("lvw model use <name>");
      const known = name.startsWith("ollama:") || name.includes(":") || findModel(name);
      if (!known) fail(`No model "${name}".`);
      const cfg = loadConfig();
      cfg.model = typeof known === "object" ? known.name : name;
      saveConfig(cfg);
      console.log(`default model: ${cfg.model}`);
      return;
    }
    default:
      console.log(MODEL_HELP);
  }
}

async function pullOne(spec: string, values: { all?: boolean; name?: string; yes?: boolean }) {
  parseSpec(spec);
  const bar = progressBar();
  const interactive = process.stdin.isTTY && !values.yes;
  const ctrl = new AbortController();
  const onSig = () => ctrl.abort();
  process.once("SIGINT", onSig);
  try {
    const m = await pull(spec, {
      all: values.all,
      name: values.name,
      signal: ctrl.signal,
      choose: interactive
        ? async (choices, def) => {
            const ctx = loadConfig().llama.ctx;
            console.log(c.bold(`${spec} offers ${choices.length} quants:`));
            choices.forEach((ch, i) => {
              const fit = fitFor(ch.size, ctx).fit;
              console.log(`  ${String(i + 1).padStart(2)}. ${ch.pattern.padEnd(10)} ${formatBytes(ch.size).padStart(9)}  ${FIT_COLOR[fit](fit)}${ch.path === def ? c.green("  (default)") : ""}`);
            });
            const a = await ask(`Pick 1-${choices.length} or press Enter for the default: `);
            const i = Number(a) - 1;
            return choices[i]?.pattern;
          }
        : undefined,
      onEvent: (e) => {
        if (e.type === "resolved") {
          console.log(`${c.bold(e.name)}  ${e.total ? formatBytes(e.total) : ""}  ${c.dim(e.files.map((f) => f.path).join(", ").slice(0, 120))}`);
          bar.reset();
        } else if (e.type === "progress") bar.update(e.file, e.done, e.total || e.fileTotal || 0);
        else if (e.type === "status") {
          bar.end();
          console.log(c.dim(e.text));
        } else if (e.type === "done") {
          bar.end();
          console.log(`${c.green("pulled")} ${e.model.name}  ${formatBytes(e.model.size)}  ${e.model.mainFile ? c.dim(`run it: lvw model run ${e.model.name}`) : c.dim(`${e.model.format}: stored, not runnable by llama.cpp`)}`);
        }
      },
    });
    return m;
  } catch (err) {
    bar.end();
    if (ctrl.signal.aborted) fail("download stopped. Run the same command again to resume.");
    throw err;
  } finally {
    process.off("SIGINT", onSig);
  }
}
