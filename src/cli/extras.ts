import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "../config.ts";
import { listNotes, removeNote, searchNotes, writeNote, type Scope } from "../memory/memory.ts";
import { addRoutine, listRoutines, parseCron, removeRoutine, setRoutineEnabled } from "../orchestra/routines.ts";
import { createTask, decideApproval, getTask, listApprovals, listTasks, taskEvents, updateTask, type TaskStatus } from "../orchestra/tasks.ts";
import { listPlugins } from "../plugins/plugins.ts";
import { addSkills, approveSkill, browseMarketplace, getSkill, installBundledSkills, listSkills, removeSkill } from "../skills/skills.ts";
import { closeMcp, mcpTools } from "../tools/mcp.ts";
import { installScrapling, removeScrapling, scraplingBin } from "../tools/scrape.ts";
import { runCommand } from "./run.ts";
import { c, confirm, fail, table } from "./ui.ts";

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "never");

export async function skillCommand(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { project: { type: "boolean" }, yes: { type: "boolean", short: "y" } } });
  const [cmd, arg] = positionals;
  const cwd = process.cwd();
  switch (cmd) {
    case "add": {
      if (!arg) fail("lvw skill add gh:owner/repo[/path][@ref] | gl:group/project[/-/path][@ref] | ./folder");
      const r = await addSkills(arg, { project: values.project ? cwd : undefined });
      for (const s of r.installed) console.log(`${c.green("added")} ${c.bold(s.name)}  ${c.dim(s.licence)}`);
      if (r.agents.length) console.log(`${c.green("added agents")} ${r.agents.join(", ")}`);
      console.log(c.dim("Read each skill's licence before you share or ship it."));
      return;
    }
    case "browse": {
      const repo = arg === "wshobson" || !arg ? "wshobson/agents" : arg;
      const plugins = await browseMarketplace(repo);
      table(plugins.map((p) => [c.bold(p.name), p.description.slice(0, 90)]));
      console.log(c.dim(`\nAdd one with: lvw skill add gh:${repo}/plugins/<name>. Its skills and subagents are installed.`));
      return;
    }
    case "rm":
      if (!arg) fail("lvw skill rm <name>");
      return console.log(`removed ${removeSkill(arg, cwd).dir}`);
    case "show": {
      const s = (arg && getSkill(arg, cwd, true)) || fail(`No skill "${arg ?? ""}".`);
      return console.log(readFileSync(s.file, "utf8"));
    }
    case "approve":
      if (!arg) fail("lvw skill approve <draft name>");
      return console.log(`${c.green("approved")} ${approveSkill(arg)}`);
    case "bundled":
      return console.log(`installed ${installBundledSkills()} bundled skills`);
    default: {
      const skills = listSkills(cwd, true);
      if (!skills.length) return console.log(c.dim("No skills yet. lvw skill bundled, or lvw skill add gh:owner/repo"));
      table(
        skills.map((s) => [c.bold(s.name), s.scope === "draft" ? c.yellow("draft") : s.scope, s.description.slice(0, 90)]),
        ["name", "scope", "description"],
      );
      if (skills.some((s) => s.scope === "draft")) console.log(c.dim("\nDrafts are skills the agent proposed. Read one with lvw skill show <name>, then lvw skill approve <name>."));
    }
  }
}

export async function memoryCommand(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { global: { type: "boolean", short: "g" } } });
  const [cmd, ...rest] = positionals;
  const cwd = process.cwd();
  switch (cmd) {
    case "search": {
      const hits = searchNotes(rest.join(" "), cwd);
      if (!hits.length) return console.log(c.dim("Nothing found."));
      for (const h of hits) console.log(`${c.bold(h.title)}  ${c.dim(h.path)}\n  ${h.snippet}\n`);
      return;
    }
    case "add": {
      const [name, ...words] = rest;
      let text = words.join(" ");
      if (!text && !process.stdin.isTTY) text = await new Response(Bun.stdin.stream()).text();
      if (!name || !text.trim()) fail('lvw memory add <name> "<text>" [--global]   (or pipe the text in)');
      const scope: Scope = values.global ? "global" : "project";
      return console.log(`saved ${writeNote(name, text, scope, cwd)}`);
    }
    case "rm":
      if (!rest[0]) fail("lvw memory rm <name>");
      return console.log(`removed ${removeNote(rest[0], cwd)}`);
    default: {
      const notes = listNotes(cwd);
      if (!notes.length) return console.log(c.dim("No memory notes yet."));
      table(
        notes.map((n) => [n.scope, c.bold(n.name), n.title === n.name ? "" : n.title.slice(0, 70)]),
        ["scope", "name", "title"],
      );
    }
  }
}

const STATUS_COLOR: Record<TaskStatus, (s: string) => string> = { todo: c.dim, doing: c.cyan, blocked: c.red, review: c.yellow, done: c.green, cancelled: c.dim };

export async function taskCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { all: { type: "boolean", short: "a" }, budget: { type: "string" }, model: { type: "string", short: "m" }, yes: { type: "boolean", short: "y" }, note: { type: "string" } },
  });
  const [cmd, ...rest] = positionals;
  const id = Number(rest[0]);
  switch (cmd) {
    case "add": {
      const [title, ...desc] = rest;
      if (!title) fail('lvw task add "<title>" ["<description>"] [--budget tokens]');
      const t = createTask({ title, description: desc.join(" "), owner: "you", budgetTokens: values.budget ? Number(values.budget) : undefined });
      return console.log(`${c.green("added")} task #${t.id}`);
    }
    case "show": {
      const t = getTask(id) ?? fail(`No task #${rest[0] ?? ""}`);
      console.log(`${c.bold(`#${t.id} ${t.title}`)}  ${STATUS_COLOR[t.status](t.status)}  ${c.dim(`owner ${t.owner ?? "-"} · ${t.used_tokens} tokens${t.budget_tokens ? ` of ${t.budget_tokens}` : ""}`)}`);
      if (t.description) console.log(`\n${t.description}`);
      console.log();
      for (const e of taskEvents(t.id)) console.log(`${c.dim(new Date(e.at).toLocaleString())}  ${e.kind.padEnd(7)} ${e.text.split("\n")[0].slice(0, 120)}`);
      if (t.result) console.log(`\n${c.bold("Result")}\n${t.result}`);
      return;
    }
    case "done":
    case "cancel":
    case "reopen": {
      if (!getTask(id)) fail(`lvw task ${cmd} <id>`);
      const status: TaskStatus = cmd === "done" ? "done" : cmd === "cancel" ? "cancelled" : "todo";
      updateTask(id, { status, note: values.note });
      return console.log(`task #${id} ${status}`);
    }
    case "run": {
      if (!getTask(id)) fail("lvw task run <id> [--yes] [--model m]");
      return runCommand(["--task", String(id), ...(values.yes ? ["--yes"] : []), ...(values.model ? ["--model", values.model] : [])]);
    }
    case "approve":
    case "reject": {
      const a = decideApproval(id, cmd === "approve");
      return console.log(`approval #${a.id} ${a.status}`);
    }
    default: {
      const tasks = listTasks({ includeDone: values.all });
      if (!tasks.length) console.log(c.dim('No open tasks. lvw task add "<title>"'));
      else
        table(
          tasks.map((t) => [`#${t.id}`, STATUS_COLOR[t.status](t.status), t.owner ?? "", t.title.slice(0, 70)]),
          ["id", "status", "owner", "title"],
        );
      const pending = listApprovals();
      if (pending.length) {
        console.log(`\n${c.yellow("Waiting for you:")}`);
        for (const a of pending) console.log(`  approval #${a.id}${a.task_id ? ` (task #${a.task_id})` : ""}: ${a.question}   ${c.dim(`lvw task approve|reject ${a.id}`)}`);
      }
    }
  }
}

export async function routineCommand(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { cwd: { type: "string" } } });
  const [cmd, ...rest] = positionals;
  switch (cmd) {
    case "add": {
      const [name, cron, ...prompt] = rest;
      if (!name || !cron || !prompt.length) fail('lvw routine add <name> "<cron>" "<prompt>" [--cwd dir]   e.g. lvw routine add news "0 8 * * 1-5" "Summarise the AI news"');
      parseCron(cron);
      const r = addRoutine(name, cron, prompt.join(" "), values.cwd ?? process.cwd());
      console.log(`${c.green("added")} routine #${r.id} ${c.bold(r.name)} (${r.cron})`);
      console.log(c.dim("Routines run while `lvw serve` is running. Each run becomes a task: lvw task ls -a"));
      return;
    }
    case "rm":
      removeRoutine(Number(rest[0]));
      return console.log(`removed routine #${rest[0]}`);
    case "on":
    case "off":
      setRoutineEnabled(Number(rest[0]), cmd === "on");
      return console.log(`routine #${rest[0]} ${cmd}`);
    default: {
      const rows = listRoutines();
      if (!rows.length) return console.log(c.dim("No routines yet."));
      table(
        rows.map((r) => [`#${r.id}`, r.enabled ? c.green("on") : c.dim("off"), c.bold(r.name), r.cron, when(r.last_run), r.prompt.slice(0, 50)]),
        ["id", "", "name", "cron", "last run", "prompt"],
      );
    }
  }
}

export async function mcpCommand(argv: string[]) {
  const dash = argv.indexOf("--");
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const { values, positionals } = parseArgs({ args: dash >= 0 ? argv.slice(0, dash) : argv, allowPositionals: true, options: { url: { type: "string" } } });
  const [cmd, name] = positionals;
  const cfg = loadConfig();
  switch (cmd) {
    case "add": {
      if (!name || (!values.url && !command.length)) fail("lvw mcp add <name> -- <command> [args…]   or   lvw mcp add <name> --url https://…/mcp");
      cfg.mcpServers[name] = values.url ? { url: values.url } : { command: command[0], args: command.slice(1) };
      saveConfig(cfg);
      return console.log(`${c.green("added")} MCP server ${c.bold(name)}. Check it with lvw mcp ls`);
    }
    case "rm":
      if (!name || !cfg.mcpServers[name]) fail(`No MCP server "${name ?? ""}".`);
      delete cfg.mcpServers[name];
      saveConfig(cfg);
      return console.log(`removed MCP server ${name}`);
    default: {
      const names = Object.keys(cfg.mcpServers);
      if (!names.length) return console.log(c.dim("No MCP servers. lvw mcp add <name> -- <command> [args…]"));
      for (const n of names) {
        const s = cfg.mcpServers[n];
        const errors: string[] = [];
        const tools = await mcpTools({ [n]: s }, process.cwd(), (_, err) => errors.push(err.message));
        console.log(`${errors.length ? c.red("--") : c.green("ok")} ${c.bold(n)}  ${c.dim(s.url ?? [s.command, ...(s.args ?? [])].join(" "))}`);
        if (errors.length) console.log(`   ${c.red(errors[0])}`);
        else console.log(`   ${tools.length} tools: ${tools.map((t) => t.name.replace(`mcp_${n}_`, "")).join(", ")}`);
      }
      await closeMcp();
    }
  }
}

export async function toolCommand(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { browsers: { type: "boolean" }, yes: { type: "boolean", short: "y" } } });
  const [cmd, name] = positionals;
  if (name !== "scrapling") fail("lvw tool install|rm scrapling [--browsers]");
  if (cmd === "install") {
    if (values.browsers && !values.yes && !(await confirm("--browsers downloads Scrapling's stealth browser (several hundred MB). Continue?"))) return;
    const bin = await installScrapling({ browsers: values.browsers });
    console.log(`${c.green("installed")} ${bin}. The agent now has a web_scrape tool${values.browsers ? " with stealth mode" : "; add --browsers for stealth mode"}.`);
  } else if (cmd === "rm") {
    await removeScrapling();
    console.log(`removed ${scraplingBin()}`);
  } else fail("lvw tool install|rm scrapling");
}

export function pluginCommand() {
  const plugins = listPlugins();
  if (!plugins.length) return console.log(c.dim("No plugins. Put one in ~/.lvw/plugins/<name>/ with a plugin.json and index.ts (see README)."));
  table(
    plugins.map((p) => [p.error ? c.red("broken") : p.manifest.enabled === false ? c.dim("off") : c.green("on"), c.bold(p.manifest.name), p.error ?? p.manifest.description ?? "", c.dim(p.dir)]),
    ["", "name", "description", "folder"],
  );
}

const AGENTS_TEMPLATE = (manifests: string[]) => `# Agent instructions

Start with the requested outcome and treat this repository as the record of truth. The map is in \`docs/README.md\`.

- Stay within the requested scope. Looking at something doesn't authorize changing or running it.
- Prefer pointing at source files over repeating them. Write down intent that code and tests can't express.
- Say what you couldn't run or verify. Don't invent commands or claim results you didn't see.
- Stop and ask when a request leaves a real product decision open.
${manifests.length ? `\nBuild files found: ${manifests.join(", ")}. Add the exact build and test commands here once you have confirmed them.\n` : ""}`;

const MAP_TEMPLATE = `# Repository map

Fill this in as you learn the repository. Run the \`onboard-repository\` skill for an evidence-based first pass.

| Question | Where to look |
|---|---|
| What is this and who is it for? | \`README.md\` |
| How is it built and tested? | |
| Where are the main entry points? | |
| Why was it built this way? | |
`;

/** After hoangnb24/repository-harness: a small entry point and a map. Only adds what is missing. */
export async function repoCommand(argv: string[]) {
  const [cmd, dir = process.cwd()] = argv;
  if (cmd !== "init") fail("lvw repo init [folder]");
  const manifests = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "Makefile", "pom.xml"].filter((f) => existsSync(join(dir, f)));
  for (const [rel, text] of [["AGENTS.md", AGENTS_TEMPLATE(manifests)], ["docs/README.md", MAP_TEMPLATE]] as const) {
    const p = join(dir, rel);
    if (existsSync(p)) {
      console.log(`${c.dim("kept")} ${rel}`);
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    console.log(`${c.green("added")} ${rel}`);
  }
}
