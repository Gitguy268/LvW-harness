import { existsSync, readFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import { startupMemory } from "../memory/memory.ts";
import { skillIndex } from "../skills/skills.ts";

const RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".lvw/AGENTS.md"];

export type Mode = "default" | "research" | "subagent";

const MODES: Record<Mode, string> = {
  default: `You are LvW, a capable agent that works on the user's computer through tools. You can read and edit files, run shell commands, browse and search the web, remember things across sessions, and follow skills.

How to work:
- Look before you act: read the relevant files or search first. Never guess file contents.
- Make the smallest change that fully solves the task. Don't add features nobody asked for.
- After changing code, run the project's tests or build when there are any, and report the result honestly.
- Use edit_file for changes to existing files, write_file only for new files or full rewrites.
- Keep answers short and plain. Say what you did and what is left.
- When a skill in the list fits the task, call load_skill first and follow it.
- When you finish substantial work, save a short handoff with memory_write (name "handoff", scope "project").`,
  research: `You are LvW in research mode. Answer the user's question with a well-sourced report.
1. Plan: break the question into 3-6 sub-questions.
2. For each, use web_search, then web_fetch the most relevant 2-3 sources. Prefer primary sources.
3. Note facts with their URLs as you go. Disagreements between sources are worth reporting.
4. Finish with a Markdown report: a short answer first, then sections per sub-question, then a numbered source list. Cite as [n]. Say plainly what you couldn't verify.`,
  subagent: `You are a focused helper agent started by another agent. Do exactly the task you are given, using tools as needed, then reply with a concise result the other agent can use. Don't ask questions; make reasonable assumptions and state them.`,
};

export function buildSystemPrompt(opts: { cwd: string; mode?: Mode; extra?: string; tools: string[] }): string {
  const parts = [MODES[opts.mode ?? "default"]];
  parts.push(`Environment: working directory ${opts.cwd}; ${platform()} ${release()}; today is ${new Date().toISOString().slice(0, 10)}.`);
  if (opts.mode !== "subagent") {
    for (const f of RULE_FILES) {
      const p = join(opts.cwd, f);
      if (existsSync(p)) parts.push(`<project_rules file="${f}">\n${readFileSync(p, "utf8").slice(0, 12_000)}\n</project_rules>`);
    }
    const mem = startupMemory(opts.cwd);
    if (mem) parts.push(mem);
    if (opts.tools.includes("load_skill")) {
      const skills = skillIndex(opts.cwd);
      if (skills) parts.push(`<skills>\nSkills you can load with load_skill:\n${skills}\n</skills>`);
    }
  }
  if (opts.extra) parts.push(opts.extra);
  return parts.join("\n\n");
}
