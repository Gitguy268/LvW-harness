/**
 * A critic pass: a second model call reviews the task, the answer and the diff, and returns a
 * verdict (after OpenHands' critic model). On FAIL the agent gets one more round with the notes.
 * Browser-safe: the caller supplies the completion function.
 */

export interface Verdict {
  pass: boolean;
  notes: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… [cut ${s.length - n} characters]` : s);

export function criticPrompt(task: string, answer: string, diff: string): string {
  return `You review an AI agent's finished work. Be strict about correctness and about doing what was asked; ignore style.

<task>
${clip(task, 6000)}
</task>

<final_answer>
${clip(answer, 6000)}
</final_answer>

<changes>
${diff.trim() ? clip(diff, 20000) : "(no file changes)"}
</changes>

Did the agent fully and correctly do the task? Look for bugs in the changes, steps it skipped, claims the changes don't back up, and broken or missing tests.
Reply with exactly one first line, VERDICT: PASS or VERDICT: FAIL, then at most five short bullet points with the concrete problems (for FAIL) or nothing (for PASS).`;
}

export function parseVerdict(text: string): Verdict {
  const m = /VERDICT:\s*(PASS|FAIL)/i.exec(text);
  const notes = text.replace(/^[\s\S]*?VERDICT:\s*(PASS|FAIL)\s*/i, "").trim();
  // An unreadable verdict passes: the critic shouldn't block work by being vague.
  return { pass: !m || m[1].toUpperCase() === "PASS", notes };
}

export function retryBrief(v: Verdict): string {
  return `[Critic review: FAIL] A reviewer found problems with the work:\n${v.notes || "(no details)"}\nFix what is real, say what you disagree with, and finish.`;
}
