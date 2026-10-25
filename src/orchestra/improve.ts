import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ResolvedChatModel } from "../core/providers.ts";
import { Session } from "../core/session.ts";
import { ensureDirs } from "../paths.ts";

/**
 * Experimental self-improvement after harness2's propose → probe → compose: run the same task once per
 * prompt strategy, each in a scratch copy of the folder, let the model grade every result, and keep
 * the winner as a profile that `lvw run|chat --profile <name>` adds to the system prompt.
 */
export const STRATEGIES = [
  { name: "baseline", prompt: "" },
  { name: "plan-first", prompt: "Before using any tool, write a short numbered plan. Follow it, and change it when you learn something that matters." },
  { name: "verify", prompt: "Never claim a step worked without checking it: re-read files you changed and run the relevant command or test. Fix failures before you answer." },
  { name: "lean", prompt: "Use as few tool calls as possible: one targeted search or read beats many. Keep the final answer to a few sentences." },
];

export interface Profile {
  name: string;
  strategy: string;
  prompt: string;
  task: string;
  model: string;
  scores: { strategy: string; score: number; tokens: number; toolCalls: number }[];
  created_at: number;
}

export interface ProbeResult {
  strategy: string;
  prompt: string;
  answer: string;
  score: number;
  reason: string;
  tokens: number;
  toolCalls: number;
  error?: string;
}

const MAX_COPY_BYTES = 50 * 1024 ** 2;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".venv", "target"]);

function folderSize(dir: string, limit: number): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    total += e.isDirectory() ? folderSize(p, limit - total) : e.isFile() ? statSync(p).size : 0;
    if (total > limit) return total;
  }
  return total;
}

/** A throwaway copy of the folder (without node_modules, .git…), or an empty folder when it's too big. */
export function scratchCopy(cwd: string): { dir: string; copied: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "lvw-improve-"));
  if (folderSize(cwd, MAX_COPY_BYTES) > MAX_COPY_BYTES) return { dir, copied: false };
  cpSync(cwd, dir, { recursive: true, filter: (src) => src === cwd || !SKIP.has(basename(src)) });
  return { dir, copied: true };
}

async function grade(resolved: ResolvedChatModel, task: string, answer: string, toolCalls: number) {
  const prompt = `You are grading an AI agent's work. Task:\n<task>\n${task}\n</task>\n\nThe agent made ${toolCalls} tool calls and answered:\n<answer>\n${answer.slice(0, 6000)}\n</answer>\n\nScore how well the task was done, 0 (failed) to 10 (fully and correctly done). Reply with JSON only: {"score": <0-10>, "reason": "<one sentence>"}`;
  const msg = await resolved.models.complete(resolved.model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
  const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  try {
    const r = JSON.parse(json ?? "") as { score?: number; reason?: string };
    return { score: Math.max(0, Math.min(10, Number(r.score) || 0)), reason: String(r.reason ?? "") };
  } catch {
    const n = /\b(10|\d)\b/.exec(text)?.[1];
    return { score: n ? Number(n) : 0, reason: text.trim().slice(0, 200) || "the grader gave no score" };
  }
}

export async function improve(opts: {
  task: string;
  cwd: string;
  resolved: ResolvedChatModel;
  strategies?: typeof STRATEGIES;
  maxTurns?: number;
  onProbe?: (strategy: string, copied: boolean) => void;
}): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const s of opts.strategies ?? STRATEGIES) {
    const ws = scratchCopy(opts.cwd);
    opts.onProbe?.(s.name, ws.copied);
    let toolCalls = 0;
    const session = await Session.create({ cwd: ws.dir, resolved: opts.resolved, permissions: "auto", extraPrompt: s.prompt || undefined, maxTurns: opts.maxTurns ?? 20, persist: false });
    session.subscribe((ev) => void (ev.type === "tool_execution_start" && toolCalls++));
    try {
      const answer = await session.prompt(opts.task);
      const tokens = session.usage.input + session.usage.output;
      const g = await grade(opts.resolved, opts.task, answer, toolCalls);
      results.push({ strategy: s.name, prompt: s.prompt, answer, tokens, toolCalls, ...g });
    } catch (err) {
      results.push({ strategy: s.name, prompt: s.prompt, answer: "", score: 0, reason: "", tokens: 0, toolCalls, error: (err as Error).message });
    } finally {
      await session.dispose();
      rmSync(ws.dir, { recursive: true, force: true });
    }
  }
  // Best score wins; fewer tokens breaks a tie.
  return results.sort((a, b) => b.score - a.score || a.tokens - b.tokens);
}

const profilePath = (name: string) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error("Profile names may only use letters, digits, '.', '-' and '_'.");
  return join(ensureDirs().profiles, `${name}.json`);
};

export function saveProfile(p: Profile) {
  writeFileSync(profilePath(p.name), JSON.stringify(p, null, 2) + "\n");
}

export function loadProfile(name: string): Profile {
  const p = profilePath(name);
  if (!existsSync(p)) throw new Error(`No profile "${name}". lvw improve ls`);
  return JSON.parse(readFileSync(p, "utf8")) as Profile;
}

export function listProfiles(): Profile[] {
  const dir = ensureDirs().profiles;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Profile);
}

export function removeProfile(name: string) {
  rmSync(profilePath(name), { force: true });
}
