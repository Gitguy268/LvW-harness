/**
 * The web UI's "server" when it runs on its own: the same /api routes and live messages as
 * src/server/server.ts and hub.ts, answered in the page.
 */
import { MODES, isMode } from "../../core/modes.ts";
import { parseRecipe, renderRecipe, type Recipe } from "../../core/recipes.ts";
import catalogJson from "../../media/catalog.json" with { type: "json" };
import { DEFAULT_MODELS, hfResolve } from "../../models/defaults.ts";
import { searchHf } from "../../models/hf.ts";
import { cronMatches, parseCron } from "../../orchestra/cron.ts";
import { parseFrontmatter } from "../../skills/frontmatter.ts";
import YAML from "yaml";
import type { Answer, ApprovalRequest } from "../../core/policy.ts";
import { browserCheckpoints } from "./checkpoints.ts";
import { db, getSettings, saveSettings, type BrowserSettings } from "./db.ts";
import { applyKeys } from "./env.ts";
import { closeFolder, openFolder, previewBlob, ROOT, useWorkspace, workspace } from "./files.ts";
import { loadedModels, onModelStatus, resolveChatModel, unload } from "./llm.ts";
import { disk, findModel, gcApply, gcScan, importFiles, inspect, listModels, pull, removeModel, type PullJob } from "./models.ts";
import { setCorsProxy } from "./net.ts";
import { BrowserSession, type Attachment, type SavedSession } from "./session.ts";
import { allSkills, searchMemory, writeMemory } from "./tools.ts";
import { transcribe } from "./whisper.ts";

type Msg = Record<string, unknown> & { type: string };
type Listener = (m: Msg) => void;

const listeners = new Set<Listener>();
const emit = (m: Msg) => {
  for (const fn of listeners) {
    try {
      fn(m);
    } catch {}
  }
};

const sessions = new Map<string, BrowserSession>();
const busy = new Set<string>();
const approvals = new Map<string, { sessionId: string; summary: string; tool: string; resolve: (a: Answer) => void }>();
const jobs = new Map<string, PullJob & { ctrl: AbortController }>();
const mediaJobs = new Map<string, Record<string, unknown> & { ctrl: AbortController }>();

const ask = (sessionId: string) => (req: ApprovalRequest) =>
  new Promise<Answer>((resolve) => {
    const id = crypto.randomUUID();
    approvals.set(id, { sessionId, summary: req.summary, tool: req.tool, resolve });
    emit({ type: "approval", id, sessionId, summary: req.summary, tool: req.tool });
  });

function answer(id: string, a: Answer) {
  const p = approvals.get(id);
  if (!p) return;
  approvals.delete(id);
  p.resolve(a);
  emit({ type: "approval_done", id });
}

async function session(o: { sessionId?: string; model?: string; agentMode?: string; permissions?: string }) {
  const existing = o.sessionId ? sessions.get(o.sessionId) : undefined;
  const mode = isMode(o.agentMode) ? o.agentMode : undefined;
  if (existing && (!mode || existing.agentMode === mode) && (!o.model || existing.model.model.id === o.model)) return existing;
  const sessionId = o.sessionId ?? crypto.randomUUID();
  const s = await BrowserSession.create({
    sessionId,
    model: o.model || undefined,
    agentMode: mode,
    permissions: o.permissions === "auto" || o.permissions === "readonly" || o.permissions === "ask" ? o.permissions : undefined,
    ask: ask(sessionId),
    onStatus: (label) => emit({ type: "session", sessionId, state: "busy", label }),
  });
  s.subscribe((event) => emit({ type: "agent", sessionId, event }));
  sessions.set(sessionId, s);
  return s;
}

async function chat(m: { sessionId?: string; text?: string; attachments?: Attachment[]; model?: string; agentMode?: string; permissions?: string }) {
  let s: BrowserSession;
  try {
    s = await session(m);
  } catch (err) {
    emit({ type: "session", sessionId: m.sessionId ?? "", state: "idle", error: (err as Error).message });
    return;
  }
  if (busy.has(s.id)) return emit({ type: "error", sessionId: s.id, error: "This chat is still working. Stop it first." });
  busy.add(s.id);
  emit({ type: "session", sessionId: s.id, state: "busy", label: s.model.label });
  try {
    await s.prompt(String(m.text ?? ""), (m.attachments ?? []).filter((a) => typeof a?.data === "string").slice(0, 8));
  } catch (err) {
    emit({ type: "error", sessionId: s.id, error: (err as Error).message });
  } finally {
    busy.delete(s.id);
    emit({ type: "session", sessionId: s.id, state: "idle", label: s.stopReason });
  }
}

function startPull(spec: string, pattern?: string, all?: boolean) {
  const ctrl = new AbortController();
  const job: PullJob & { ctrl: AbortController } = { id: crypto.randomUUID(), spec, status: "running", done: 0, total: 0, ctrl };
  jobs.set(job.id, job);
  let last = 0;
  const publish = (force = false) => {
    if (!force && Date.now() - last < 250) return;
    last = Date.now();
    const { ctrl: _c, ...plain } = job;
    emit({ type: "job", job: plain });
  };
  pull(spec, { pattern, all, signal: ctrl.signal, job, emit: () => publish() })
    .then((model) => {
      job.status = "done";
      job.model = model;
      job.done = job.total || model.size;
    })
    .catch((err: Error) => {
      job.status = ctrl.signal.aborted ? "cancelled" : "error";
      job.error = err.message;
    })
    .finally(() => publish(true));
  const { ctrl: _c, ...plain } = job;
  return plain;
}

// ---- media: only speech to text runs in the browser ------------------------------------

const withUrl = <T extends { text?: string }>(r: T) => ({ ...r, url: `data:text/plain;charset=utf-8,${encodeURIComponent(r.text ?? "")}` });

interface MediaOut {
  rel: string;
  kind: string;
  mime: string;
  text?: string;
  meta: Record<string, unknown>;
  time: number;
}

async function mediaInfo() {
  const models = await listModels();
  const whisper = models.find((m) => m.role === "transcribe");
  const catalog = (catalogJson.entries as { id: string; kinds: string[]; engine: string; name: string; licence: string; sizeGB: number; note?: string }[]).map((e) => ({
    ...e,
    ready: e.engine === "whispercpp" ? Boolean(whisper) : false,
    browser: e.engine === "whispercpp",
    note: e.engine === "whispercpp" ? e.note : `${e.note ?? ""} Needs the desktop LvW-harness (connect it in Settings).`.trim(),
  }));
  const outputs = (await db.all<MediaOut>("media")).sort((a, b) => b.time - a.time).map(withUrl);
  return { catalog, outputs, jobs: [...mediaJobs.values()].map(({ ctrl: _c, ...j }) => j), uv: true, sd: false };
}

function startMake(body: { kind: string; audio?: string; language?: string; translate?: boolean; prompt?: string }) {
  const ctrl = new AbortController();
  const job: Record<string, unknown> & { ctrl: AbortController } = { id: crypto.randomUUID(), action: "make", kind: body.kind, label: (body.prompt ?? body.kind).slice(0, 80), status: "running", ctrl };
  mediaJobs.set(String(job.id), job);
  const publish = () => {
    const { ctrl: _c, ...plain } = job;
    emit({ type: "media", job: plain });
  };
  (async () => {
    if (body.kind !== "transcribe") throw new Error(`Making ${body.kind} needs the desktop LvW-harness. Connect it in Settings; in the browser only speech to text runs.`);
    const whisper = (await listModels()).find((m) => m.role === "transcribe");
    if (!whisper) throw new Error("Get Whisper large-v3-turbo on the Models page first.");
    if (!body.audio) throw new Error("Transcription needs audio.");
    const bytes = Uint8Array.from(atob(body.audio), (c) => c.charCodeAt(0));
    const out = await transcribe(whisper.name, bytes.buffer, { language: body.language, translate: body.translate, onStatus: (s) => ((job.note = s), publish()) });
    const rec: MediaOut = { rel: `transcribe/${Date.now()}.txt`, kind: "transcribe", mime: "text/plain", text: out.text, meta: { model: whisper.name, language: out.language }, time: Date.now() };
    await db.put("media", rec.rel, rec);
    job.output = withUrl(rec);
  })()
    .then(() => (job.status = "done"))
    .catch((err: Error) => ((job.status = "error"), (job.error = err.message)))
    .finally(publish);
  publish();
  const { ctrl: _c, ...plain } = job;
  return plain;
}

// ---- tasks and routines ---------------------------------------------------------------

interface Task {
  id: number;
  title: string;
  description: string;
  status: "todo" | "doing" | "blocked" | "review" | "done";
  owner?: string;
  result?: string;
  created_at: number;
}
interface Routine {
  id: number;
  name: string;
  cron: string;
  prompt: string;
  cwd: string | null;
  enabled: number;
  last_run: number | null;
}

async function runTask(id: number) {
  const t = await db.get<Task>("tasks", String(id));
  if (!t) throw new Error(`No task #${id}`);
  await db.put("tasks", String(id), { ...t, status: "doing", owner: "lvw" });
  emit({ type: "tasks" });
  try {
    const s = await session({});
    busy.add(s.id);
    const answerText = await s.prompt(`${t.title}\n\n${t.description}`.trim());
    busy.delete(s.id);
    await db.put("tasks", String(id), { ...t, status: s.stopReason ? "blocked" : "review", result: answerText });
  } catch (err) {
    await db.put("tasks", String(id), { ...t, status: "blocked", result: (err as Error).message });
  }
  emit({ type: "tasks" });
}

setInterval(async () => {
  const now = new Date();
  for (const r of await db.all<Routine>("routines")) {
    if (!r.enabled || (r.last_run && now.getTime() - r.last_run < 60_000)) continue;
    try {
      if (!cronMatches(r.cron, now)) continue;
    } catch {
      continue;
    }
    await db.put("routines", String(r.id), { ...r, last_run: now.getTime() });
    const id = Date.now();
    await db.put<Task>("tasks", String(id), { id, title: `${r.name} (routine)`, description: r.prompt, status: "todo", owner: "routine", created_at: id });
    void runTask(id);
  }
}, 20_000);

// ---- recipes in the browser -------------------------------------------------------------

const yamlParse = (t: string) => YAML.parse(t);
interface StoredRecipe {
  name: string;
  scope: "user" | "project";
  text: string;
}

// ---- router -----------------------------------------------------------------------------

type Handler = (p: Record<string, string>, body: Record<string, unknown>, q: URLSearchParams) => Promise<unknown> | unknown;
const routes: [string, RegExp, string[], Handler][] = [];
const route = (method: string, path: string, h: Handler) => {
  const names: string[] = [];
  const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")).replace(/\*$/, "(.*)")}$`);
  if (path.endsWith("*")) names.push("rest");
  routes.push([method, re, names, h]);
};

route("GET", "/api/status", async () => {
  const s = await getSettings();
  const d = await disk();
  return { version: __LVW_VERSION__, model: s.model ?? null, permissions: s.permissions, running: loadedModels()[0] ? { modelName: loadedModels()[0], modelId: loadedModels()[0] } : null, free: d.free, ollama: false, cwd: ROOT, auth: false, browser: true, workspace: workspace().label, isolated: crossOriginIsolated, gpu: "gpu" in navigator };
});
route("GET", "/api/sessions", async () => (await db.all<SavedSession>("sessions")).sort((a, b) => b.updated_at - a.updated_at).slice(0, 30).map(({ messages: _m, ...s }) => s));
route("GET", "/api/sessions/:id", async (p) => (await db.get<SavedSession>("sessions", p.id))?.messages ?? []);
route("DELETE", "/api/sessions/:id", async (p) => (await db.del("sessions", p.id), sessions.delete(p.id), { ok: true }));

route("GET", "/api/models", async () => (await listModels()).map((m) => ({ ...m, source: "browser" })));
route("GET", "/api/models/search", async (_p, _b, q) => searchHf(q.get("q") ?? "", 25));
route("GET", "/api/models/inspect", async (_p, _b, q) => inspect(q.get("spec") ?? ""));
route("POST", "/api/models/pull", (_p, b) => startPull(String(b.spec ?? ""), b.pattern ? String(b.pattern) : undefined, Boolean(b.all)));
route("GET", "/api/jobs", () => [...jobs.values()].map(({ ctrl: _c, ...j }) => j));
route("POST", "/api/jobs/:id/cancel", (p) => (jobs.get(p.id)?.ctrl.abort(), mediaJobs.get(p.id)?.ctrl.abort(), { ok: true }));
route("POST", "/api/models/stop", async () => (await unload(), { stopped: true }));
route("DELETE", "/api/models/:name", async (p) => {
  await unload(decodeURIComponent(p.name));
  return removeModel(decodeURIComponent(p.name));
});
route("POST", "/api/models/:name/run", async (p) => {
  const name = decodeURIComponent(p.name);
  await resolveChatModel(name);
  await import("./llm.ts").then(async () => {
    const r = await fetch("http://wllama.lvw/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: name, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 }) });
    if (!r.ok) throw new Error(await r.text());
  });
  return { modelName: name };
});
route("POST", "/api/models/:name/default", async (p) => (await saveSettings({ model: decodeURIComponent(p.name) }), { ok: true }));
route("GET", "/api/disk", () => disk());
route("GET", "/api/gc", () => gcScan());
route("POST", "/api/gc", () => gcApply());
route("GET", "/api/defaults", async () => {
  const have = await listModels();
  return DEFAULT_MODELS.map((d) => {
    const installed = have.some((m) => m.spec.includes(d.repo));
    // The exact main file; a vision model's projector comes along by itself.
    const spec = d.browser ? `hf:${d.repo}:${d.browser.files[0]}` : d.native;
    return { ...d, spec, media: false, available: Boolean(d.browser), why: d.browser ? undefined : "Connect your LvW-harness in Settings", sizeGB: d.browser?.sizeGB, installed, url: d.browser ? hfResolve(d.repo, d.browser.files[0]) : undefined };
  });
});

route("GET", "/api/tasks", async () => ({ tasks: (await db.all<Task>("tasks")).sort((a, b) => a.id - b.id), approvals: [] }));
route("POST", "/api/tasks", async (_p, b) => {
  const id = Date.now();
  const t: Task = { id, title: String(b.title ?? ""), description: String(b.description ?? ""), status: "todo", created_at: id };
  await db.put("tasks", String(id), t);
  emit({ type: "tasks" });
  return t;
});
route("PATCH", "/api/tasks/:id", async (p, b) => {
  const t = await db.get<Task>("tasks", p.id);
  if (!t) throw new Error("No such task.");
  await db.put("tasks", p.id, { ...t, ...(b.status ? { status: b.status as Task["status"] } : {}) });
  emit({ type: "tasks" });
  return { ok: true };
});
route("POST", "/api/tasks/:id/run", (p) => (void runTask(Number(p.id)), { ok: true }));
route("GET", "/api/routines", () => db.all<Routine>("routines"));
route("POST", "/api/routines", async (_p, b) => {
  parseCron(String(b.cron ?? ""));
  const id = Date.now();
  const r: Routine = { id, name: String(b.name ?? "routine"), cron: String(b.cron), prompt: String(b.prompt ?? ""), cwd: null, enabled: 1, last_run: null };
  await db.put("routines", String(id), r);
  return r;
});
route("DELETE", "/api/routines/:id", async (p) => (await db.del("routines", p.id), { ok: true }));

route("GET", "/api/memory", async () => (await db.all<{ name: string; scope: string; title: string; body: string }>("memory")).map((n) => ({ ...n })));
route("PUT", "/api/memory", async (_p, b) => ({ path: await writeMemory(String(b.name ?? ""), String(b.content ?? ""), b.scope === "global" ? "global" : "project") }));
route("DELETE", "/api/memory/:name", async (p) => (await db.del("memory", decodeURIComponent(p.name)), { ok: true }));
route("GET", "/api/memory/search", async (_p, _b, q) => searchMemory(q.get("q") ?? ""));

route("GET", "/api/skills", async () => (await allSkills()).map((s) => ({ name: s.name, description: s.description, scope: s.scope === "bundled" ? "user" : s.scope })));
route("POST", "/api/skills", async (_p, b) => {
  // gh:owner/repo[/path]: every folder with a SKILL.md, read through the GitHub API (it allows web pages).
  const m = /^(?:gh:)?([\w.-]+\/[\w.-]+)(?:\/(.+))?$/.exec(String(b.spec ?? "").trim());
  if (!m) throw new Error("Use gh:owner/repo or gh:owner/repo/path/to/skills.");
  const [, repo, sub = ""] = m;
  const info = await (await fetch(`https://api.github.com/repos/${repo}`)).json();
  if (!info.default_branch) throw new Error(`GitHub has no repo ${repo}.`);
  const tree = await (await fetch(`https://api.github.com/repos/${repo}/git/trees/${info.default_branch}?recursive=1`)).json();
  const dirs = (tree.tree as { path: string }[]).filter((e) => e.path.endsWith("SKILL.md") && e.path.startsWith(sub)).map((e) => e.path.slice(0, -"SKILL.md".length).replace(/\/$/, ""));
  if (!dirs.length) throw new Error(`No SKILL.md files in ${repo}${sub ? `/${sub}` : ""}.`);
  const installed = [];
  for (const dir of dirs.slice(0, 30)) {
    const files: Record<string, string> = {};
    for (const e of (tree.tree as { path: string; type: string; size?: number }[]).filter((x) => x.type === "blob" && x.path.startsWith(dir ? dir + "/" : "") && (x.size ?? 0) < 400_000)) {
      if (!dir && e.path.includes("/")) continue;
      files[dir ? e.path.slice(dir.length + 1) : e.path] = await (await fetch(`https://raw.githubusercontent.com/${repo}/${info.default_branch}/${e.path.split("/").map(encodeURIComponent).join("/")}`)).text();
    }
    const fm = parseFrontmatter(files["SKILL.md"] ?? "");
    const name = fm.name || dir.split("/").pop() || repo.split("/")[1];
    await db.put("skills", name, { name, description: fm.description ?? "", scope: "user", files });
    installed.push({ name, licence: info.license?.spdx_id ?? "unknown" });
  }
  return { installed };
});
route("POST", "/api/skills/:name/approve", async (p) => {
  const s = await db.get<{ scope: string }>("skills", decodeURIComponent(p.name));
  if (!s) throw new Error("No such draft.");
  await db.put("skills", decodeURIComponent(p.name), { ...s, scope: "user" });
  return { ok: true };
});
route("DELETE", "/api/skills/:name", async (p) => {
  const name = decodeURIComponent(p.name);
  if (!(await db.get("skills", name))) throw new Error(`${name} is bundled with LvW and can't be removed here.`);
  await db.del("skills", name);
  return { ok: true };
});

route("POST", "/api/compare", async (_p, b) => {
  const out = [];
  for (const ref of (b.models as string[]) ?? []) {
    const t = performance.now();
    try {
      const r = await resolveChatModel(ref);
      const reply = await r.models.completeSimple(r.model, { systemPrompt: "Answer helpfully and concisely.", messages: [{ role: "user", content: String(b.prompt ?? ""), timestamp: Date.now() }] });
      const text = (reply.content ?? []).filter((x: { type: string }) => x.type === "text").map((x: { type: string; text?: string }) => x.text ?? "").join("");
      out.push({ model: ref, text, ms: performance.now() - t, tokens: reply.usage?.output });
    } catch (err) {
      out.push({ model: ref, error: (err as Error).message, ms: performance.now() - t });
    }
  }
  return out;
});

route("GET", "/api/media", () => mediaInfo());
route("POST", "/api/media/make", (_p, b) => startMake(b as never));
route("POST", "/api/media/pull", async (_p, b) => {
  const id = String(b.id ?? "");
  if (id !== "whisper-large-v3-turbo") throw new Error("That engine needs the desktop LvW-harness. Connect it in Settings.");
  const d = DEFAULT_MODELS.find((x) => x.native === id)!;
  return startPull(`hf:${d.repo}:${d.browser!.files[0]}`);
});
route("DELETE", "/api/media/models/:id", async () => {
  const w = (await listModels()).find((m) => m.role === "transcribe");
  if (w) await removeModel(w.name);
  return { ok: true };
});
route("DELETE", "/api/media/out/*", async (p) => (await db.del("media", decodeURIComponent(p.rest)), { removed: true }));

route("GET", "/api/modes", async () => ({ modes: Object.values(MODES), current: (await getSettings()).mode, pinned: (await getSettings()).modes }));
route("GET", "/api/settings", async () => {
  const s = await getSettings();
  const masked = Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, v ? `${v.slice(0, 4)}…${v.slice(-2)}` : ""]));
  return { ...s, keys: masked, visionModel: s.visionModel ?? null, model: s.model ?? null, workspace: workspace().label, workspaceKind: workspace().kind };
});
route("PUT", "/api/settings", async (_p, b) => {
  const s = await getSettings();
  const patch: Partial<BrowserSettings> = {};
  if (b.mode !== undefined && isMode(b.mode)) patch.mode = b.mode;
  if (b.modes) patch.modes = b.modes as BrowserSettings["modes"];
  if (b.checks) patch.checks = { ...s.checks, ...(b.checks as object) };
  if (b.critic) patch.critic = { ...s.critic, ...(b.critic as object) };
  if (b.visionModel !== undefined) patch.visionModel = (b.visionModel as string) || undefined;
  if (b.permissions) patch.permissions = b.permissions as BrowserSettings["permissions"];
  if (b.corsProxy !== undefined) patch.corsProxy = String(b.corsProxy || "") || undefined;
  if (b.searxngUrl !== undefined) patch.searxngUrl = String(b.searxngUrl || "") || undefined;
  if (b.ctx) patch.ctx = Math.max(2048, Math.min(131072, Number(b.ctx)));
  if (b.gpu !== undefined) patch.gpu = Boolean(b.gpu);
  if (b.keys) {
    // Masked values ("abcd…xy") mean "unchanged"; empty clears.
    const keys = { ...s.keys };
    for (const [k, v] of Object.entries(b.keys as Record<string, string>)) if (!v) delete keys[k];
    else if (!v.includes("…")) keys[k] = v.trim();
    patch.keys = keys;
  }
  const next = await saveSettings(patch);
  applyKeys(next.keys);
  setCorsProxy(next.corsProxy);
  sessions.clear();
  return { ok: true };
});
route("POST", "/api/workspace/open", async () => {
  const ws = await openFolder();
  await useWorkspace(ws);
  sessions.clear();
  return { label: ws.label };
});
route("POST", "/api/workspace/close", async () => {
  const ws = await closeFolder();
  sessions.clear();
  return { label: ws.label };
});

const checkpoints = () => browserCheckpoints();
route("GET", "/api/checkpoints", () => checkpoints().list(40));
route("GET", "/api/checkpoints/diff", async (_p, _b, q) => ({ diff: await checkpoints().diff(q.get("id") ?? "") }));
route("POST", "/api/checkpoints/restore", async (_p, b) => checkpoints().restore(String(b.id ?? "")));

route("GET", "/api/recipes", async () =>
  (await db.all<StoredRecipe>("recipes")).map((r) => {
    try {
      return { ...r, path: `browser/${r.name}.yaml`, recipe: parseRecipe(r.text, yamlParse) };
    } catch (err) {
      return { ...r, path: `browser/${r.name}.yaml`, error: (err as Error).message };
    }
  }),
);
route("PUT", "/api/recipes", async (_p, b) => {
  const recipe: Recipe = parseRecipe(String(b.text ?? ""), yamlParse);
  await db.put<StoredRecipe>("recipes", recipe.name, { name: recipe.name, scope: b.scope === "project" ? "project" : "user", text: String(b.text) });
  return { path: `browser/${recipe.name}.yaml` };
});
route("DELETE", "/api/recipes/:name", async (p) => (await db.del("recipes", decodeURIComponent(p.name)), { path: decodeURIComponent(p.name) }));
route("POST", "/api/recipes/:name/render", async (p, b) => {
  const r = await db.get<StoredRecipe>("recipes", decodeURIComponent(p.name));
  if (!r) throw new Error("No such recipe.");
  const recipe = parseRecipe(r.text, yamlParse);
  return { prompt: renderRecipe(recipe, (b.values as Record<string, string>) ?? {}), mode: recipe.mode ?? null, model: recipe.model ?? null };
});

export async function request(path: string, opts: { method?: string; body?: unknown } = {}) {
  const url = new URL(path, "http://lvw.local");
  const method = (opts.method ?? "GET").toUpperCase();
  const body = typeof opts.body === "string" ? JSON.parse(opts.body || "{}") : ((opts.body as Record<string, unknown>) ?? {});
  for (const [m, re, names, h] of routes) {
    if (m !== method) continue;
    const hit = re.exec(url.pathname);
    if (!hit) continue;
    const params = Object.fromEntries(names.map((n, i) => [n, hit[i + 1]]));
    return h(params, body, url.searchParams);
  }
  throw new Error(`${method} ${url.pathname} isn't available in the browser version.`);
}

/** Files from this computer → a model, reported as a download job so the Models page shows progress. */
export function upload(files: File[]) {
  const ctrl = new AbortController();
  const job: PullJob & { ctrl: AbortController } = { id: crypto.randomUUID(), spec: files.map((f) => f.name).join(" + "), status: "running", done: 0, total: files.reduce((n, f) => n + f.size, 0), note: "Copying into the browser's storage…", ctrl };
  jobs.set(job.id, job);
  const publish = () => {
    const { ctrl: _c, ...plain } = job;
    emit({ type: "job", job: plain });
  };
  importFiles(files, (done) => ((job.done = done), publish()))
    .then((m) => ((job.status = "done"), (job.model = m)))
    .catch((err: Error) => ((job.status = "error"), (job.error = err.message)))
    .finally(publish);
  publish();
  const { ctrl: _c, ...plain } = job;
  return plain;
}

export function connect(onMessage: Listener, onState?: (up: boolean) => void) {
  listeners.add(onMessage);
  for (const [id, a] of approvals) onMessage({ type: "approval", id, sessionId: a.sessionId, summary: a.summary, tool: a.tool });
  onState?.(true);
}

export function send(m: Msg) {
  if (m.type === "chat") void chat(m as never);
  else if (m.type === "abort") sessions.get(String(m.sessionId))?.abort();
  else if (m.type === "approve") answer(String(m.id), (m.answer as Answer) ?? "no");
}

onModelStatus((label) => {
  for (const id of busy) emit({ type: "session", sessionId: id, state: "busy", label });
});

export async function init() {
  const s = await getSettings();
  applyKeys(s.keys);
  setCorsProxy(s.corsProxy);
  await (await import("./files.ts")).restoreWorkspace();
  void findModel;
}

export { previewBlob };

declare const __LVW_VERSION__: string;
