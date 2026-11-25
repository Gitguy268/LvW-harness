import { existsSync, readFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import { startupMemory } from "../memory/memory.ts";
import { skillIndex } from "../skills/skills.ts";

const RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".lvw/AGENTS.md"];

import { BASE_PROMPTS, environmentLine, type Mode } from "./prompt-text.ts";

export type { Mode };

export function buildSystemPrompt(opts: { cwd: string; mode?: Mode; extra?: string; tools: string[]; skillChars?: number }): string {
  const parts = [BASE_PROMPTS[opts.mode ?? "default"]];
  parts.push(environmentLine(opts.cwd, `${platform()} ${release()}`));
  if (opts.mode !== "subagent") {
    for (const f of RULE_FILES) {
      const p = join(opts.cwd, f);
      if (existsSync(p)) parts.push(`<project_rules file="${f}">\n${readFileSync(p, "utf8").slice(0, 12_000)}\n</project_rules>`);
    }
    const mem = startupMemory(opts.cwd);
    if (mem) parts.push(mem);
    if (opts.tools.includes("load_skill")) {
      const skills = skillIndex(opts.cwd, opts.skillChars);
      if (skills) parts.push(`<skills>\nSkills you can load with load_skill:\n${skills}\n</skills>`);
    }
  }
  if (opts.extra) parts.push(opts.extra);
  return parts.join("\n\n");
}
