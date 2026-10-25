import { Type } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolContext } from "./tool.ts";

const IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.next|\.venv|__pycache__|target)(\/|$)/;

export function fsTools(ctx: ToolContext) {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(ctx.cwd, p.replace(/^~(?=\/)/, process.env.HOME ?? "~")));
  const show = (p: string) => {
    const r = relative(ctx.cwd, p);
    return r.startsWith("..") ? p : r || ".";
  };

  const read = defineTool({
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
      if (!existsSync(p)) throw new Error(`No such file: ${show(p)}`);
      if (statSync(p).isDirectory()) throw new Error(`${show(p)} is a directory; use list_files.`);
      const lines = readFileSync(p, "utf8").split("\n");
      const start = Math.max(1, offset ?? 1);
      const slice = lines.slice(start - 1, start - 1 + (limit ?? 2000));
      const body = slice.map((l, i) => `${String(start + i).padStart(5)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
      const more = start - 1 + slice.length < lines.length ? `\n… ${lines.length - (start - 1 + slice.length)} more lines (use offset)` : "";
      return body + more;
    },
  });

  const write = defineTool({
    name: "write_file",
    label: "Write",
    description: "Create or overwrite a file with the given content. Creates parent folders.",
    risk: "write",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute({ path, content }) {
      const p = abs(path);
      mkdirSync(dirname(p), { recursive: true });
      const existed = existsSync(p);
      writeFileSync(p, content);
      return `${existed ? "Overwrote" : "Created"} ${show(p)} (${content.split("\n").length} lines)`;
    },
  });

  const edit = defineTool({
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
      if (!existsSync(p)) throw new Error(`No such file: ${show(p)}`);
      const text = readFileSync(p, "utf8");
      const count = old_text ? text.split(old_text).length - 1 : 0;
      if (count === 0) throw new Error(`old_text not found in ${show(p)}. Read the file and copy the text exactly.`);
      if (count > 1 && !replace_all) throw new Error(`old_text appears ${count} times in ${show(p)}. Add surrounding lines to make it unique, or set replace_all.`);
      writeFileSync(p, replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text));
      return `Edited ${show(p)} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""})`;
    },
  });

  const list = defineTool({
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
      const out: string[] = [];
      for await (const f of new Bun.Glob(pattern ?? "**/*").scan({ cwd: root, dot: false, onlyFiles: true })) {
        if (IGNORE.test(f)) continue;
        out.push(f);
        if (out.length >= 500) break;
      }
      out.sort();
      return out.length ? out.join("\n") + (out.length >= 500 ? "\n… (first 500)" : "") : "No files match.";
    },
  });

  const grep = defineTool({
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
    async execute({ pattern, path, glob, ignore_case }, signal) {
      const root = abs(path ?? ".");
      const rg = Bun.which("rg");
      if (rg) {
        const args = [rg, "--line-number", "--no-heading", "--color=never", "--max-columns=300", "-m", "50"];
        if (ignore_case) args.push("-i");
        if (glob) args.push("-g", glob);
        args.push("--", pattern, root);
        const r = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal });
        const text = await new Response(r.stdout).text();
        await r.exited;
        const lines = text.split("\n").filter(Boolean).map((l) => (l.startsWith(root) ? relative(ctx.cwd, l.slice(0, l.indexOf(":"))) + l.slice(l.indexOf(":")) : l));
        return lines.length ? lines.slice(0, 300).join("\n") + (lines.length > 300 ? `\n… ${lines.length - 300} more` : "") : "No matches.";
      }
      const re = new RegExp(pattern, ignore_case ? "i" : "");
      const hits: string[] = [];
      const files = statSync(root).isFile() ? [root] : [];
      if (!files.length) for await (const f of new Bun.Glob(glob ? `**/${glob}` : "**/*").scan({ cwd: root, onlyFiles: true })) if (!IGNORE.test(f)) files.push(resolve(root, f));
      for (const f of files) {
        if (statSync(f).size > 2_000_000) continue;
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
          if (hits.length < 300 && re.test(line)) hits.push(`${show(f)}:${i + 1}:${line.slice(0, 300)}`);
        });
      }
      return hits.length ? hits.join("\n") : "No matches.";
    },
  });

  return [read, write, edit, list, grep];
}
