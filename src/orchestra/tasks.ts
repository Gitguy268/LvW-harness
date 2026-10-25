import { getDb } from "../db.ts";

/** A small task board after paperclip: tasks with an owner, status, budget and history. */
export type TaskStatus = "todo" | "doing" | "blocked" | "review" | "done" | "cancelled";
export const STATUSES: TaskStatus[] = ["todo", "doing", "blocked", "review", "done", "cancelled"];

export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  parent_id: number | null;
  budget_tokens: number | null;
  used_tokens: number;
  result: string | null;
  created_at: number;
  updated_at: number;
}

export function createTask(t: { title: string; description?: string; owner?: string; parentId?: number; budgetTokens?: number }): Task {
  const now = Date.now();
  const row = getDb()
    .query(
      "INSERT INTO tasks (title, description, owner, parent_id, budget_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(t.title, t.description ?? "", t.owner ?? null, t.parentId ?? null, t.budgetTokens ?? null, now, now) as Task;
  addEvent(row.id, "created", t.title);
  return row;
}

export function getTask(id: number): Task | undefined {
  return (getDb().query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null) ?? undefined;
}

export function listTasks(filter: { status?: string; includeDone?: boolean } = {}): Task[] {
  const db = getDb();
  if (filter.status) return db.query("SELECT * FROM tasks WHERE status = ? ORDER BY id").all(filter.status) as Task[];
  return db.query(`SELECT * FROM tasks ${filter.includeDone ? "" : "WHERE status NOT IN ('done','cancelled')"} ORDER BY id`).all() as Task[];
}

export function updateTask(id: number, patch: { status?: TaskStatus; result?: string; owner?: string; note?: string; addTokens?: number }) {
  const t = getTask(id);
  if (!t) throw new Error(`No task #${id}.`);
  if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`Status must be one of ${STATUSES.join(", ")}.`);
  getDb()
    .query("UPDATE tasks SET status = ?, result = ?, owner = ?, used_tokens = used_tokens + ?, updated_at = ? WHERE id = ?")
    .run(patch.status ?? t.status, patch.result ?? t.result, patch.owner ?? t.owner, patch.addTokens ?? 0, Date.now(), id);
  if (patch.status && patch.status !== t.status) addEvent(id, "status", `${t.status} → ${patch.status}`);
  if (patch.note) addEvent(id, "note", patch.note);
  if (patch.result) addEvent(id, "result", patch.result.slice(0, 2000));
  return getTask(id)!;
}

export function addEvent(taskId: number, kind: string, text: string) {
  getDb().query("INSERT INTO task_events (task_id, at, kind, text) VALUES (?, ?, ?, ?)").run(taskId, Date.now(), kind, text);
}

export function taskEvents(taskId: number) {
  return getDb().query("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(taskId) as { id: number; at: number; kind: string; text: string }[];
}

export interface Approval {
  id: number;
  task_id: number | null;
  session_id: string | null;
  question: string;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  decided_at: number | null;
}

export function requestApproval(question: string, taskId?: number, sessionId?: string): Approval {
  const row = getDb()
    .query("INSERT INTO approvals (task_id, session_id, question, created_at) VALUES (?, ?, ?, ?) RETURNING *")
    .get(taskId ?? null, sessionId ?? null, question, Date.now()) as Approval;
  if (taskId) updateTask(taskId, { status: "blocked", note: `waiting for approval #${row.id}: ${question}` });
  return row;
}

export function listApprovals(status = "pending"): Approval[] {
  return getDb().query("SELECT * FROM approvals WHERE status = ? ORDER BY id").all(status) as Approval[];
}

export function decideApproval(id: number, approved: boolean) {
  const a = getDb().query("SELECT * FROM approvals WHERE id = ?").get(id) as Approval | null;
  if (!a) throw new Error(`No approval #${id}.`);
  getDb().query("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(approved ? "approved" : "rejected", Date.now(), id);
  if (a.task_id) updateTask(a.task_id, { status: approved ? "todo" : "cancelled", note: `approval #${id} ${approved ? "granted" : "refused"}` });
  return { ...a, status: approved ? "approved" : "rejected" };
}
