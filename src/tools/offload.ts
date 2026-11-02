import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.ts";
import type { LvwTool } from "./tool.ts";

// These return text the agent asked for by range, or instructions it must read whole.
const NEVER = new Set(["read_file", "load_skill", "todo"]);
const WEEK_MS = 7 * 24 * 3600 * 1000;

function clearOld(root: string) {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (Date.now() - statSync(dir).mtimeMs > WEEK_MS) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * After deepagents: a big tool result goes to a file, and the model gets its start, its end
 * and the path. One long command output can't push a small model's context over the edge.
 */
export function offloadLargeOutput(tool: LvwTool, sessionId: string, contextWindow: number): LvwTool {
  if (NEVER.has(tool.name)) return tool;
  const limit = Math.min(20_000, Math.floor(contextWindow * 3.5 * 0.25));
  let count = 0;
  return {
    ...tool,
    execute: async (...args) => {
      const out = await tool.execute(...args);
      const text = out.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      if (text.length <= limit) return out;
      const root = join(paths().home, "tool-output");
      const dir = join(root, sessionId);
      mkdirSync(dir, { recursive: true });
      clearOld(root);
      const file = join(dir, `${tool.name}-${++count}.txt`);
      writeFileSync(file, text);
      const part = Math.floor(limit / 2) - 100;
      const preview = `${text.slice(0, part)}\n\n… ${text.length - part * 2} characters left out. The full output is in ${file}; use read_file with offset and limit, or grep. …\n\n${text.slice(-part)}`;
      return { ...out, content: [{ type: "text", text: preview }] };
    },
  };
}
