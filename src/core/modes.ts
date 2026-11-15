/**
 * Agent modes, after Kilo Code / Cline / OpenCode (Code, Plan, Ask, Debug), Aider's architect
 * mode, and LvW's research mode. Browser-safe: no node imports.
 *
 * Plan and Ask can't change anything: the session runs them with read-only permissions, so the
 * normal approval rules refuse writes and non-read-only commands. A mode can have its own model
 * (config.modes.<mode>.model), so planning can use a stronger model than editing.
 */
import type { AgentMode, PermissionMode } from "../config.ts";

export interface ModeSpec {
  id: AgentMode;
  label: string;
  /** One line for pickers and help. */
  summary: string;
  readOnly: boolean;
  /** Add the repository map to the system prompt (when the context window allows). */
  repoMap: boolean;
  /** Extra instructions after the base prompt. */
  prompt: string;
}

export const MODES: Record<AgentMode, ModeSpec> = {
  code: {
    id: "code",
    label: "Code",
    summary: "Read, edit and run things to get the task done.",
    readOnly: false,
    repoMap: true,
    prompt: "",
  },
  plan: {
    id: "plan",
    label: "Plan",
    summary: "Look around and write a plan. Changes nothing.",
    readOnly: true,
    repoMap: true,
    prompt: `Plan mode: you may read files, search and run read-only commands, but you can't change anything. Investigate first, then answer with a numbered plan: the files to change and how, the order, risks, and how to check the result. End by asking whether to go ahead (the user switches to Code mode for that).`,
  },
  ask: {
    id: "ask",
    label: "Ask",
    summary: "Answer questions about the code or anything else. Changes nothing.",
    readOnly: true,
    repoMap: false,
    prompt: `Ask mode: answer the question. You may read files and search to ground the answer, but you can't change anything. Point to files and lines when that helps.`,
  },
  debug: {
    id: "debug",
    label: "Debug",
    summary: "Reproduce the problem first, then find the cause and fix it.",
    readOnly: false,
    repoMap: true,
    prompt: `Debug mode: 1) Reproduce the problem and show the failing output. 2) Form one or two hypotheses and test them with the smallest experiment (logs, a focused test, reading the code path). 3) Fix the cause, not the symptom. 4) Rerun the reproduction and the tests to prove the fix. Report the root cause in one or two sentences.`,
  },
  architect: {
    id: "architect",
    label: "Architect",
    summary: "A planner model writes the plan, an editor model carries it out.",
    readOnly: false,
    repoMap: true,
    prompt: "",
  },
  research: {
    id: "research",
    label: "Research",
    summary: "Search the web and write a sourced report.",
    readOnly: false,
    repoMap: false,
    prompt: "",
  },
};

export const MODE_IDS = Object.keys(MODES) as AgentMode[];

export function isMode(x: unknown): x is AgentMode {
  return typeof x === "string" && x in MODES;
}

/** The permissions a mode runs with: read-only modes can't be talked out of it. */
export function modePermissions(mode: AgentMode, chosen: PermissionMode): PermissionMode {
  return MODES[mode].readOnly ? "readonly" : chosen;
}

/** Which model a mode uses when none is given explicitly. */
export function modeModel(mode: AgentMode, modes: Partial<Record<AgentMode, { model?: string; editor?: string }>>, fallback?: string): string | undefined {
  if (mode === "architect") return modes.architect?.editor ?? fallback;
  return modes[mode]?.model ?? fallback;
}

/** Turn a planner's plan into the editor's instructions (Aider's architect → editor hand-off). */
export function editorBrief(task: string, plan: string): string {
  return `The architect planned this task. Carry out the plan exactly, editing the files it names. If a step turns out to be wrong, fix it the smallest sensible way and say so.

<task>
${task}
</task>

<plan>
${plan.trim()}
</plan>`;
}

export const ARCHITECT_PROMPT = `You are the architect. Study the task and the code (read-only), then write a precise plan an editor can follow without guessing: for each file, what to change and why, with the exact names involved. No code blocks longer than a few lines. Don't edit anything yourself.`;
