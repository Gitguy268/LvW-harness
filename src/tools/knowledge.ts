import { Type } from "@earendil-works/pi-ai";
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { searchNotes, writeNote } from "../memory/memory.ts";
import { getSkill, proposeSkill } from "../skills/skills.ts";
import { defineTool, type ToolContext } from "./tool.ts";

export function knowledgeTools(ctx: ToolContext) {
  return [
    defineTool({
      name: "memory_search",
      label: "Search memory",
      description: "Search your long-term Markdown memory (global and this project) for earlier decisions, facts and handoffs.",
      risk: "read",
      parameters: Type.Object({ query: Type.String() }),
      async execute({ query }) {
        const hits = searchNotes(query, ctx.cwd);
        if (!hits.length) return "Nothing in memory matches.";
        return hits.map((h) => `## ${h.title}\n${h.path}\n${h.snippet}`).join("\n\n");
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
        const p = writeNote(name, content, scope ?? "project", ctx.cwd);
        return `Saved ${p}`;
      },
    }),
    defineTool({
      name: "load_skill",
      label: "Load skill",
      description: "Load the full instructions of a skill from the skills list, plus the names of its extra files (read them with read_file).",
      risk: "read",
      parameters: Type.Object({ name: Type.String() }),
      async execute({ name }) {
        const s = getSkill(name, ctx.cwd);
        if (!s) throw new Error(`No skill "${name}".`);
        const extra = (readdirSync(s.dir, { recursive: true }) as string[]).filter((f) => f !== "SKILL.md" && !/^LICENSE/i.test(f));
        return `${readFileSync(s.file, "utf8")}\n\nSkill folder: ${s.dir}${extra.length ? `\nFiles: ${extra.slice(0, 50).map((f) => relative(".", f)).join(", ")}` : ""}`;
      },
    }),
    defineTool({
      name: "skill_propose",
      label: "Propose skill",
      description: "After solving a task you expect to repeat, write it down as a reusable skill. It is saved as a draft the user approves with `lvw skill approve <name>`.",
      risk: "write",
      parameters: Type.Object({
        name: Type.String({ description: "kebab-case name" }),
        description: Type.String({ description: "When to use it, in one or two sentences" }),
        body: Type.String({ description: "Markdown instructions: steps, commands, pitfalls" }),
      }),
      async execute({ name, description, body }) {
        return `Draft saved at ${proposeSkill(name, description, body)}. The user can approve it with: lvw skill approve ${name}`;
      },
    }),
  ];
}
