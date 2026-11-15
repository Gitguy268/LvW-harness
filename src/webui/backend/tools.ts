/**
 * The agent's tools in the browser: the same names, parameters and wording as the native ones,
 * working on the browser workspace (just-bash for the shell).
 */
import { Type } from "@earendil-works/pi-ai";
import { Bash } from "just-bash/browser";
import { buildRepoMap } from "../../core/repomap.ts";
import type { Config } from "../../config.ts";
import { parseFrontmatter } from "../../skills/frontmatter.ts";
import bundledSkills from "../../skills/bundled.json" with { type: "json" };
import { defineTool, type LvwTool, type ToolContext } from "../../tools/tool.ts";
import { todoTool } from "../../tools/todo.ts";
import { webTools } from "../../tools/web.ts";
import { db } from "./db.ts";
import { ROOT, workspace } from "./files.ts";

const IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.next|\.venv|__pycache__|target)(\/|$)/;
const abs = (p: string) => (p.startsWith("/") ? p : `${ROOT}/${p.replace(/^\.\/?/, "")}`.replace(/\/+$/, "") || ROOT);
const show = (p: string) => (p.startsWith(ROOT + "/") ? p.slice(ROOT.length + 1) : p === ROOT ? "." : p);

/** Glob → RegExp (**, *, ?, {a,b}). */
function globRe(glob: string) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(?:${glob.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

let bash: Bash | undefined;
let bashFs: unknown;
/** One shell per workspace, so `cd`, variables and files carry over between commands. */
export function shell() {
  const ws = workspace();
  if (!bash || bashFs !== ws.fs) {
    bash = new Bash({ fs: ws.fs, cwd: ROOT, env: { HOME: ROOT, USER: "lvw", PWD: ROOT }, network: { dangerouslyAllowFullInternetAccess: true }, javascript: true });
    bashFs = ws.fs;
  }
  return bash;
}

export interface BrowserToolContext extends ToolContext {
  flush: () => Promise<void>;
}

export function fileTools(ctx: BrowserToolContext): LvwTool[] {
  const fs = () => workspace().fs;
  return [
    defineTool({
      name: "read_file",
      label: "Read",
      description: "Read a text file. Returns numbered lines. Use offset/limit for big files.",
      risk: "read",
      parameters: Type.Object({
        path: Type.String({ description: "File path, relative to the working directory or absolute" }),
        offset: Type.Optional(Type.Number({ description: "First line to read (1-based)" })),
        limit: Type.Optional(Type.Number({ description: "Number of lines (default 2000)" })),
      }),
      async execute({ path, offset, limit }) {
        const p = abs(path);
        if (!(await fs().exists(p))) throw new Error(`No such file: ${show(p)}`);
        if ((await fs().stat(p)).isDirectory) throw new Error(`${show(p)} is a directory; use list_files.`);
        const lines = (await fs().readFile(p)).split("\n");
        const start = Math.max(1, offset ?? 1);
        const slice = lines.slice(start - 1, start - 1 + (limit ?? 2000));
        const body = slice.map((l, i) => `${String(start + i).padStart(5)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
        const more = start - 1 + slice.length < lines.length ? `\n… ${lines.length - (start - 1 + slice.length)} more lines (use offset)` : "";
        return body + more;
      },
    }),
    defineTool({
      name: "write_file",
      label: "Write",
      description: "Create or overwrite a file with the given content. Creates parent folders.",
      risk: "write",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute({ path, content }) {
        const p = abs(path);
        const existed = await fs().exists(p);
        await fs().mkdir(p.slice(0, p.lastIndexOf("/")) || "/", { recursive: true });
        await fs().writeFile(p, content);
        await ctx.flush();
        return `${existed ? "Overwrote" : "Created"} ${show(p)} (${content.split("\n").length} lines)`;
      },
    }),
    defineTool({
      name: "edit_file",
      label: "Edit",
      description: "Replace exact text in a file. old_text must appear exactly once unless replace_all is true. Read the file first.",
      risk: "write",
      parameters: Type.Object({
        path: Type.String(),
        old_text: Type.String({ description: "Exact text to replace, including whitespace" }),
        new_text: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      async execute({ path, old_text, new_text, replace_all }) {
        const p = abs(path);
        if (!(await fs().exists(p))) throw new Error(`No such file: ${show(p)}`);
        const text = await fs().readFile(p);
        const count = old_text ? text.split(old_text).length - 1 : 0;
        if (count === 0) throw new Error(`old_text not found in ${show(p)}. Read the file and copy the text exactly.`);
        if (count > 1 && !replace_all) throw new Error(`old_text appears ${count} times in ${show(p)}. Add surrounding lines to make it unique, or set replace_all.`);
        await fs().writeFile(p, replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text));
        await ctx.flush();
        return `Edited ${show(p)} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""})`;
      },
    }),
    defineTool({
      name: "list_files",
      label: "List",
      description: "List files matching a glob (default **/*), skipping node_modules, .git and build folders.",
      risk: "read",
      parameters: Type.Object({
        pattern: Type.Optional(Type.String({ description: "Glob, e.g. src/**/*.ts" })),
        path: Type.Optional(Type.String({ description: "Folder to search in" })),
      }),
      async execute({ pattern, path }) {
        const root = abs(path ?? ".");
        const re = globRe(pattern ?? "**/*");
        const out = fs()
          .getAllPaths()
          .filter((p) => p.startsWith(root + "/"))
          .map((p) => p.slice(root.length + 1))
          .filter((p) => !IGNORE.test(p) && re.test(p));
        const files: string[] = [];
        for (const p of out) if (!(await fs().stat(`${root}/${p}`)).isDirectory) files.push(p);
        files.sort();
        return files.length ? files.slice(0, 500).join("\n") + (files.length > 500 ? "\n… (first 500)" : "") : "No files match.";
      },
    }),
    defineTool({
      name: "grep",
      label: "Search",
      description: "Search file contents with a regular expression. Returns file:line: text.",
      risk: "read",
      parameters: Type.Object({
        pattern: Type.String({ description: "Regular expression" }),
        path: Type.Optional(Type.String({ description: "File or folder (default: working directory)" })),
        glob: Type.Optional(Type.String({ description: "Only files matching this glob, e.g. *.ts" })),
        ignore_case: Type.Optional(Type.Boolean()),
      }),
      async execute({ pattern, path, glob, ignore_case }) {
        const root = abs(path ?? ".");
        const re = new RegExp(pattern, ignore_case ? "i" : "");
        const g = glob ? globRe(glob.includes("/") ? glob : `**/${glob}`) : undefined;
        const hits: string[] = [];
        const candidates = (await fs().exists(root)) && !(await fs().stat(root)).isDirectory ? [root] : fs().getAllPaths().filter((p) => p.startsWith(root + "/") && !IGNORE.test(p));
        for (const f of candidates) {
          if (hits.length >= 300) break;
          const st = await fs().stat(f);
          if (st.isDirectory || st.size > 2_000_000) continue;
          if (g && !g.test(f.slice(root.length + 1))) continue;
          (await fs().readFile(f)).split("\n").forEach((line, i) => {
            if (hits.length < 300 && re.test(line)) hits.push(`${show(f)}:${i + 1}:${line.slice(0, 300)}`);
          });
        }
        return hits.length ? hits.join("\n") : "No matches.";
      },
    }),
  ];
}

export function shellTools(ctx: BrowserToolContext): LvwTool[] {
  return [
    defineTool({
      name: "bash",
      label: "Shell",
      description:
        "Run a shell command in the working directory. This shell is just-bash, a bash emulation in the browser: the usual file and text commands (ls, cat, grep, sed, awk, find, jq, sort, head, curl…) work, but there are no real programs like node, python, git or npm. Returns stdout, stderr and the exit code.",
      risk: "exec",
      parameters: Type.Object({ command: Type.String(), timeout_seconds: Type.Optional(Type.Number({ description: "Default 120" })) }),
      async execute({ command, timeout_seconds }, signal) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), (timeout_seconds ?? 120) * 1000);
        signal?.addEventListener("abort", () => ctrl.abort());
        try {
          const r = await shell().exec(command, { signal: ctrl.signal });
          await ctx.flush();
          const clip = (s: string) => (s.length > 30_000 ? `${s.slice(0, 15_000)}\n… [${s.length - 30_000} characters cut] …\n${s.slice(-15_000)}` : s);
          return [r.stdout && clip(r.stdout.trimEnd()), r.stderr && `[stderr]\n${clip(r.stderr.trimEnd())}`, `[exit ${r.exitCode}${ctrl.signal.aborted && !signal?.aborted ? ", timed out" : ""}]`].filter(Boolean).join("\n");
        } finally {
          clearTimeout(timer);
        }
      },
    }),
  ];
}

interface Note {
  name: string;
  scope: "global" | "project";
  title: string;
  body: string;
  updated: number;
}

export async function searchMemory(query: string, limit = 8) {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  return (await db.all<Note>("memory"))
    .map((n) => ({ n, score: terms.reduce((s, t) => s + (n.title.toLowerCase().includes(t) ? 3 : 0) + (n.body.toLowerCase().split(t).length - 1), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ n }) => ({ title: n.title, path: `${n.scope}/${n.name}`, snippet: n.body.slice(0, 400) }));
}

export async function writeMemory(name: string, content: string, scope: "global" | "project") {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "note";
  const title = /^#\s+(.+)$/m.exec(content)?.[1] ?? name;
  await db.put<Note>("memory", slug, { name: slug, scope, title, body: content, updated: Date.now() });
  return `${scope}/${slug}`;
}

/** Bundled skills plus the ones installed or approved in this browser. */
export async function allSkills(): Promise<{ name: string; description: string; scope: string; files: Record<string, string> }[]> {
  const out = new Map<string, { name: string; description: string; scope: string; files: Record<string, string> }>();
  for (const [dir, files] of Object.entries(bundledSkills as Record<string, Record<string, string>>)) {
    const fm = parseFrontmatter(files["SKILL.md"] ?? "");
    out.set(fm.name || dir, { name: fm.name || dir, description: fm.description ?? "", scope: "bundled", files });
  }
  for (const s of await db.all<{ name: string; description: string; scope: string; files: Record<string, string> }>("skills")) out.set(s.name, s);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function knowledgeTools(): LvwTool[] {
  return [
    defineTool({
      name: "memory_search",
      label: "Search memory",
      description: "Search your long-term Markdown memory (global and this project) for earlier decisions, facts and handoffs.",
      risk: "read",
      parameters: Type.Object({ query: Type.String() }),
      async execute({ query }) {
        const hits = await searchMemory(query);
        return hits.length ? hits.map((h) => `## ${h.title}\n${h.path}\n${h.snippet}`).join("\n\n") : "Nothing in memory matches.";
      },
    }),
    defineTool({
      name: "memory_write",
      label: "Remember",
      description:
        "Save a Markdown memory note. scope=project for facts about this codebase, global for facts about the user. Use name 'handoff' (project) at the end of substantial work: what was done, what failed, what is open.",
      risk: "write",
      parameters: Type.Object({
        name: Type.String({ description: "Short name; becomes the file name" }),
        content: Type.String({ description: "Markdown body" }),
        scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")])),
      }),
      async execute({ name, content, scope }) {
        return `Saved ${await writeMemory(name, content, scope ?? "project")}`;
      },
    }),
    defineTool({
      name: "load_skill",
      label: "Load skill",
      description: "Load the full instructions of a skill from the skills list, plus the names of its extra files (read them with read_file).",
      risk: "read",
      parameters: Type.Object({ name: Type.String() }),
      async execute({ name }) {
        const s = (await allSkills()).find((x) => x.name === name && x.scope !== "draft");
        if (!s) throw new Error(`No skill "${name}".`);
        // Extra files go into the workspace so read_file and bash can use them.
        const dir = `${ROOT}/.lvw/skills/${s.name}`;
        const extra = Object.keys(s.files).filter((f) => f !== "SKILL.md" && !/^LICENSE/i.test(f));
        for (const f of extra) {
          await workspace().fs.mkdir(`${dir}/${f}`.slice(0, `${dir}/${f}`.lastIndexOf("/")), { recursive: true });
          await workspace().fs.writeFile(`${dir}/${f}`, s.files[f]);
        }
        return `${s.files["SKILL.md"]}\n\nSkill folder: .lvw/skills/${s.name}${extra.length ? `\nFiles: ${extra.slice(0, 50).join(", ")}` : ""}`;
      },
    }),
    defineTool({
      name: "skill_propose",
      label: "Propose skill",
      description: "After solving a task you expect to repeat, write it down as a reusable skill. It is saved as a draft the user approves on the Skills page.",
      risk: "write",
      parameters: Type.Object({
        name: Type.String({ description: "kebab-case name" }),
        description: Type.String({ description: "When to use it, in one or two sentences" }),
        body: Type.String({ description: "Markdown instructions: steps, commands, pitfalls" }),
      }),
      async execute({ name, description, body }) {
        const md = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body}\n`;
        await db.put("skills", name, { name, description, scope: "draft", files: { "SKILL.md": md } });
        return `Draft skill ${name} saved. The user can approve it on the Skills page.`;
      },
    }),
  ];
}

export function repoMapTool(): LvwTool {
  return defineTool({
    name: "repo_map",
    label: "Repo map",
    description: "A condensed map of the working folder: source files and their main symbols, most-used first. Use it to find where things live before reading files.",
    risk: "read",
    parameters: Type.Object({ max_chars: Type.Optional(Type.Number({ description: "Default 8000" })) }),
    async execute({ max_chars }) {
      return (await repoMapText(Math.min(40_000, Math.max(1000, max_chars ?? 8000)))) || "No source files found here.";
    },
  });
}

export async function repoMapText(budget: number) {
  if (budget <= 0) return "";
  const ws = workspace();
  const files = [];
  for (const p of ws.list().slice(0, 3000)) {
    try {
      const st = await ws.fs.stat(`${ROOT}/${p}`);
      if (st.isDirectory || st.size > 150_000) continue;
      files.push({ path: p, text: await ws.fs.readFile(`${ROOT}/${p}`) });
    } catch {}
  }
  return buildRepoMap(files, budget);
}

export function commonTools(ctx: BrowserToolContext, config: Pick<Config, "searxngUrl">): LvwTool[] {
  return [...fileTools(ctx), ...shellTools(ctx), ...webTools({ ...ctx, config: { ...ctx.config, searxngUrl: config.searxngUrl } }), ...knowledgeTools(), repoMapTool(), todoTool()];
}
