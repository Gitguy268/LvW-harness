import { getDb } from "../db.ts";

/** Recurring work on a cron schedule (paperclip's routines): each run becomes a task with its own history. */
export interface Routine {
  id: number;
  name: string;
  cron: string;
  prompt: string;
  cwd: string | null;
  enabled: number;
  last_run: number | null;
}

/** Standard 5-field cron: minute hour day-of-month month day-of-week (0 or 7 = Sunday). */
export { cronMatches, parseCron } from "./cron.ts";
import { cronMatches, parseCron } from "./cron.ts";

export function addRoutine(name: string, cron: string, prompt: string, cwd?: string): Routine {
  parseCron(cron);
  return getDb().query("INSERT INTO routines (name, cron, prompt, cwd) VALUES (?, ?, ?, ?) RETURNING *").get(name, cron, prompt, cwd ?? null) as Routine;
}

export function listRoutines(): Routine[] {
  return getDb().query("SELECT * FROM routines ORDER BY id").all() as Routine[];
}

export function removeRoutine(id: number) {
  getDb().query("DELETE FROM routines WHERE id = ?").run(id);
}

export function setRoutineEnabled(id: number, enabled: boolean) {
  getDb().query("UPDATE routines SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

/** Routines due at this minute that haven't run in it yet. */
export function dueRoutines(now = new Date()): Routine[] {
  const minute = Math.floor(now.getTime() / 60_000);
  return listRoutines().filter((r) => r.enabled && cronMatches(r.cron, now) && (!r.last_run || Math.floor(r.last_run / 60_000) < minute));
}

export function markRun(id: number, at = Date.now()) {
  getDb().query("UPDATE routines SET last_run = ? WHERE id = ?").run(at, id);
}
