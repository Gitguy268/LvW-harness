import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { PermissionMode } from "../config.ts";
import type { Answer, ApprovalRequest } from "../core/permissions.ts";
import { Session, type Attachment } from "../core/session.ts";
import { pull } from "../models/manager.ts";
import type { ModelRecord } from "../models/types.ts";
import type { MakeRequest } from "../media/make.ts";
import type { MediaOutput } from "../media/store.ts";
import { dueRoutines, markRun } from "../orchestra/routines.ts";
import { createTask, getTask, updateTask } from "../orchestra/tasks.ts";

/** Everything the web UI, routines and channels share: live sessions, download jobs and pending approvals. */
export type HubMessage =
  | { type: "agent"; sessionId: string; event: AgentEvent }
  | { type: "session"; sessionId: string; state: "busy" | "idle"; label?: string; error?: string }
  | { type: "approval"; id: string; sessionId: string; summary: string; tool: string }
  | { type: "approval_done"; id: string }
  | { type: "job"; job: Job }
  | { type: "media"; job: MediaJob }
  | { type: "tasks" };

export interface Job {
  id: string;
  spec: string;
  status: "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  file?: string;
  note?: string;
  error?: string;
  model?: ModelRecord;
}

/** A make or pull from the Create page. */
export interface MediaJob {
  id: string;
  action: "make" | "pull";
  kind?: string;
  label: string;
  status: "running" | "done" | "error" | "cancelled";
  note?: string;
  step?: number;
  total?: number;
  done?: number;
  size?: number;
  preview?: string;
  output?: MediaOutput;
  error?: string;
}

type Listener = (m: HubMessage) => void;

class Hub {
  private listeners = new Set<Listener>();
  private sessions = new Map<string, Session>();
  private busy = new Set<string>();
  private approvals = new Map<string, { sessionId: string; summary: string; tool: string; resolve: (a: Answer) => void }>();
  jobs = new Map<string, Job & { ctrl: AbortController }>();
  defaultCwd = process.cwd();

  on(fn: Listener) {
    this.listeners.add(fn);
    // Late joiners still see what's waiting for them.
    for (const [id, a] of this.approvals) fn({ type: "approval", id, sessionId: a.sessionId, summary: a.summary, tool: a.tool });
    return () => this.listeners.delete(fn);
  }

  emit(m: HubMessage) {
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch {}
    }
  }

  ask = (sessionId: string) => (req: ApprovalRequest) =>
    new Promise<Answer>((resolve) => {
      const id = randomUUID();
      this.approvals.set(id, { sessionId, summary: req.summary, tool: req.tool, resolve });
      this.emit({ type: "approval", id, sessionId, summary: req.summary, tool: req.tool });
      setTimeout(() => this.answer(id, "no"), 15 * 60_000);
    });

  answer(id: string, a: Answer) {
    const p = this.approvals.get(id);
    if (!p) return false;
    this.approvals.delete(id);
    p.resolve(a);
    this.emit({ type: "approval_done", id });
    return true;
  }

  async session(opts: { sessionId?: string; model?: string; cwd?: string; permissions?: PermissionMode; mode?: "default" | "research"; taskId?: number }) {
    const existing = opts.sessionId ? this.sessions.get(opts.sessionId) : undefined;
    if (existing && (!opts.model || existing.ctx.model.model.id === opts.model || opts.model === existing.ctx.config.model)) return existing;
    if (existing) {
      await existing.dispose();
      this.sessions.delete(existing.id);
    }
    const sessionId = opts.sessionId ?? randomUUID();
    const s = await Session.create({
      cwd: opts.cwd || this.defaultCwd,
      model: opts.model,
      permissions: opts.permissions,
      mode: opts.mode,
      taskId: opts.taskId,
      sessionId,
      ask: this.ask(sessionId),
      onStatus: (text) => this.emit({ type: "session", sessionId, state: "busy", label: text }),
    });
    s.subscribe((event) => this.emit({ type: "agent", sessionId: s.id, event }));
    this.sessions.set(s.id, s);
    return s;
  }

  /** Send a prompt; events stream to every listener. */
  async prompt(opts: Parameters<Hub["session"]>[0] & { text: string; attachments?: Attachment[] }) {
    let s: Session;
    try {
      s = await this.session(opts);
    } catch (err) {
      this.emit({ type: "session", sessionId: opts.sessionId ?? "", state: "idle", error: (err as Error).message });
      throw err;
    }
    if (this.busy.has(s.id)) throw new Error("This chat is still working. Stop it first.");
    this.busy.add(s.id);
    this.emit({ type: "session", sessionId: s.id, state: "busy", label: s.ctx.model.label });
    try {
      const answer = await s.prompt(opts.text, opts.attachments);
      return { session: s, answer };
    } finally {
      this.busy.delete(s.id);
      this.emit({ type: "session", sessionId: s.id, state: "idle", label: s.stopReason });
    }
  }

  abort(sessionId: string) {
    this.sessions.get(sessionId)?.abort();
  }

  async close(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) await s.dispose();
    this.sessions.delete(sessionId);
  }

  startPull(spec: string, opts: { pattern?: string; all?: boolean; name?: string } = {}) {
    const ctrl = new AbortController();
    const job: Job & { ctrl: AbortController } = { id: randomUUID(), spec, status: "running", done: 0, total: 0, ctrl };
    this.jobs.set(job.id, job);
    const publish = () => {
      const { ctrl: _, ...plain } = job;
      this.emit({ type: "job", job: plain });
    };
    let last = 0;
    pull(spec, {
      ...opts,
      signal: ctrl.signal,
      onEvent: (e) => {
        if (e.type === "resolved") job.total = e.total;
        if (e.type === "progress") {
          job.done = e.done;
          job.total = e.total || e.fileTotal || job.total;
          job.file = e.file;
        }
        if (e.type === "status") job.note = e.text;
        if (e.type !== "progress" || Date.now() - last > 250) {
          last = Date.now();
          publish();
        }
      },
    })
      .then((m) => {
        job.status = "done";
        job.model = m;
        job.done = job.total || m.size;
      })
      .catch((err: Error) => {
        job.status = ctrl.signal.aborted ? "cancelled" : "error";
        job.error = err.message;
      })
      .finally(publish);
    return job;
  }

  cancelJob(id: string) {
    this.jobs.get(id)?.ctrl.abort();
    this.mediaJobs.get(id)?.ctrl.abort();
  }

  mediaJobs = new Map<string, MediaJob & { ctrl: AbortController }>();

  /** Run a make or a media pull in the background; progress goes to every listener. */
  startMedia(action: "make" | "pull", arg: MakeRequest | string) {
    const ctrl = new AbortController();
    const label = typeof arg === "string" ? arg : (arg.prompt ?? arg.kind).slice(0, 80);
    const job: MediaJob & { ctrl: AbortController } = { id: randomUUID(), action, kind: typeof arg === "string" ? undefined : arg.kind, label, status: "running", ctrl };
    this.mediaJobs.set(job.id, job);
    let last = 0;
    const publish = (force = false) => {
      if (!force && Date.now() - last < 300) return;
      last = Date.now();
      const { ctrl: _, ...plain } = job;
      this.emit({ type: "media", job: plain });
    };
    const work: Promise<unknown> = import("../media/make.ts").then((m): Promise<unknown> =>
      typeof arg === "string"
        ? m.pullMedia(arg, {
            signal: ctrl.signal,
            onEvent: (e) => {
              if (e.type === "status") job.note = e.text;
              else Object.assign(job, { note: e.file, done: e.done, size: e.total });
              publish();
            },
          })
        : m.make(arg, {
            signal: ctrl.signal,
            onProgress: (p) => {
              Object.assign(job, { note: p.status, step: p.step, total: p.total, preview: p.preview });
              publish();
            },
          }),
    );
    work
      .then((r) => {
        job.status = "done";
        job.preview = undefined;
        if (action === "make") job.output = r as MediaOutput;
      })
      .catch((err: Error) => {
        job.status = ctrl.signal.aborted ? "cancelled" : "error";
        job.error = err.message;
      })
      .finally(() => publish(true));
    publish(true);
    const { ctrl: _, ...plain } = job;
    return plain;
  }

  listJobs(): Job[] {
    return [...this.jobs.values()].map(({ ctrl: _, ...j }) => j);
  }

  /** Run a board task in its own session; the result goes back on the task. */
  async runTask(id: number, opts: { model?: string; cwd?: string } = {}) {
    const t = getTask(id);
    if (!t) throw new Error(`No task #${id}`);
    updateTask(id, { status: "doing", owner: "lvw" });
    this.emit({ type: "tasks" });
    try {
      const { session, answer } = await this.prompt({ text: `${t.title}\n\n${t.description}`.trim(), model: opts.model, cwd: opts.cwd, taskId: id });
      updateTask(id, { status: session.stopReason ? "blocked" : "review", result: answer, addTokens: session.usage.input + session.usage.output, note: session.stopReason });
    } catch (err) {
      updateTask(id, { status: "blocked", note: (err as Error).message });
    }
    this.emit({ type: "tasks" });
  }

  private timer?: ReturnType<typeof setInterval>;
  startScheduler() {
    const tick = () => {
      for (const r of dueRoutines()) {
        markRun(r.id);
        const t = createTask({ title: `${r.name} (routine)`, description: r.prompt, owner: "routine" });
        void this.runTask(t.id, { cwd: r.cwd ?? undefined });
      }
    };
    this.timer = setInterval(tick, 20_000);
    tick();
  }

  stopScheduler() {
    clearInterval(this.timer);
  }
}

export const hub = new Hub();
