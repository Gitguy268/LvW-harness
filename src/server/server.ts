import type { ServerWebSocket } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { loadConfig, saveConfig, type PermissionMode } from "../config.ts";
import { deleteSession, getSessionMessages, listSessions } from "../core/session.ts";
import { fitFor, freeBytes } from "../models/disk.ts";
import { searchHf } from "../models/hf.ts";
import { diskUsage, gcApply, gcScan, listAll, removeModel, resolveSpec } from "../models/manager.ts";
import { listChoices } from "../models/select.ts";
import { listNotes, removeNote, writeNote, type Scope } from "../memory/memory.ts";
import { ensureDirs } from "../paths.ts";
import { addRoutine, listRoutines, removeRoutine, setRoutineEnabled } from "../orchestra/routines.ts";
import { createTask, decideApproval, listApprovals, listTasks, taskEvents, updateTask, type TaskStatus } from "../orchestra/tasks.ts";
import { serverState, startServer, stopServer } from "../runtime/llamacpp.ts";
import { ollamaAvailable } from "../runtime/ollama.ts";
import { addSkills, approveSkill, listSkills, removeSkill } from "../skills/skills.ts";
import appJs from "../web/app.js" with { type: "text" };
import indexHtmlBundle from "../web/index.html" with { type: "text" };
import styleCss from "../web/style.css" with { type: "text" };
import { hub, type HubMessage } from "./hub.ts";

// Bun types .html imports as bundles; with type "text" it is the file's text.
const indexHtml = indexHtmlBundle as unknown as string;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const PREVIEW_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".css": "text/css",
  ".js": "text/javascript",
  ".md": "text/plain",
  ".txt": "text/plain",
  ".json": "application/json",
};

export interface ServeOptions {
  host: string;
  port: number;
  token?: string;
  cwd: string;
}

export function createServer(opts: ServeOptions) {
  hub.defaultCwd = opts.cwd;
  const needAuth = Boolean(opts.token);
  const authed = (req: Request) => {
    if (!needAuth) return true;
    const header = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const cookie = /(?:^|;\s*)lvw_token=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    const given = header ?? (cookie ? decodeURIComponent(cookie) : undefined);
    return Boolean(given && safeEqual(given, opts.token!));
  };
  // Without a token the server trusts loopback, so refuse what a web page could send: a foreign
  // Origin (cross-site requests, WebSockets) or a foreign Host (DNS rebinding).
  const sameOrigin = (req: Request) => {
    const host = req.headers.get("host") ?? "";
    if (!needAuth && !LOOPBACK.has(host.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""))) return false;
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  };
  const body = async <T>(req: Request) => (await req.json().catch(() => ({}))) as T;
  const guard =
    (fn: (req: Request & { params: Record<string, string> }) => Response | Promise<Response>) =>
    async (req: Request & { params: Record<string, string> }) => {
      if (!sameOrigin(req)) return bad("Cross-site request refused.", 403);
      if (!authed(req)) return bad("Log in first.", 401);
      try {
        return await fn(req);
      } catch (err) {
        return bad((err as Error).message, 500);
      }
    };

  const server = Bun.serve<{ off?: () => void }>({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 120,
    routes: {
      "/": () => new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-src 'self'; style-src 'self' 'unsafe-inline'" } }),
      "/app.js": () => new Response(appJs, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
      "/style.css": () => new Response(styleCss, { headers: { "content-type": "text/css; charset=utf-8" } }),
      "/api/login": {
        POST: async (req: Request) => {
          if (!sameOrigin(req)) return bad("Cross-site request refused.", 403);
          const { token } = await body<{ token?: string }>(req);
          if (needAuth && !(token && safeEqual(token, opts.token!))) return bad("Wrong token.", 401);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json", "set-cookie": `lvw_token=${encodeURIComponent(token ?? "")}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${opts.host !== "127.0.0.1" ? "; Secure" : ""}` },
          });
        },
      },
      "/api/status": guard(async () => {
        const cfg = loadConfig();
        return json({ version: pkg.version, model: cfg.model, permissions: cfg.permissions, running: serverState(), free: freeBytes(ensureDirs().models), ollama: await ollamaAvailable(), cwd: opts.cwd, auth: needAuth });
      }),
      "/api/models": guard(async () => json(await listAll())),
      "/api/models/inspect": guard(async (req) => {
        const spec = new URL(req.url).searchParams.get("spec");
        if (!spec) return bad("spec is required");
        const r = await resolveSpec(spec);
        const ctx = loadConfig().llama.ctx;
        return json({ dir: r.dir, name: r.name, note: r.note, selected: r.selected.map((f) => f.path), choices: listChoices(r.available).map((ch) => ({ ...ch, fit: ch.size ? fitFor(ch.size, ctx).fit : undefined })) });
      }),
      "/api/models/search": guard(async (req) => json(await searchHf(new URL(req.url).searchParams.get("q") ?? "", 25))),
      "/api/models/pull": {
        POST: guard(async (req) => {
          const b = await body<{ spec?: string; pattern?: string; all?: boolean; name?: string }>(req);
          if (!b.spec) return bad("spec is required");
          const { ctrl: _, ...job } = hub.startPull(b.spec, b);
          return json(job);
        }),
      },
      "/api/jobs": guard(() => json(hub.listJobs())),
      "/api/jobs/:id/cancel": { POST: guard((req) => (hub.cancelJob(req.params.id), json({ ok: true }))) },
      "/api/models/stop": { POST: guard(async () => json({ stopped: await stopServer() })) },
      "/api/models/:name": {
        DELETE: guard(async (req) => {
          const r = await removeModel(decodeURIComponent(req.params.name));
          const cfg = loadConfig();
          if (cfg.model === r.name) {
            delete cfg.model;
            saveConfig(cfg);
          }
          return json(r);
        }),
      },
      "/api/models/:name/run": { POST: guard(async (req) => json(await startServer(decodeURIComponent(req.params.name)))) },
      "/api/models/:name/default": {
        POST: guard((req) => {
          const cfg = loadConfig();
          cfg.model = decodeURIComponent(req.params.name);
          saveConfig(cfg);
          return json({ model: cfg.model });
        }),
      },
      "/api/disk": guard(() => json(diskUsage())),
      "/api/gc": {
        GET: guard(() => json(gcScan())),
        POST: guard(() => json({ freed: gcApply(gcScan()) })),
      },
      "/api/sessions": guard(() => json(listSessions())),
      "/api/sessions/:id": {
        GET: guard((req) => json(getSessionMessages(req.params.id))),
        DELETE: guard(async (req) => {
          await hub.close(req.params.id);
          deleteSession(req.params.id);
          return json({ ok: true });
        }),
      },
      "/api/tasks": {
        GET: guard(() => json({ tasks: listTasks({ includeDone: true }), approvals: listApprovals() })),
        POST: guard(async (req) => {
          const b = await body<{ title?: string; description?: string }>(req);
          if (!b.title) return bad("title is required");
          const t = createTask({ title: b.title, description: b.description, owner: "you" });
          hub.emit({ type: "tasks" });
          return json(t);
        }),
      },
      "/api/tasks/:id": {
        GET: guard((req) => json(taskEvents(Number(req.params.id)))),
        PATCH: guard(async (req) => {
          const b = await body<{ status?: TaskStatus; note?: string }>(req);
          const t = updateTask(Number(req.params.id), b);
          hub.emit({ type: "tasks" });
          return json(t);
        }),
      },
      "/api/tasks/:id/run": {
        POST: guard(async (req) => {
          const b = await body<{ model?: string }>(req);
          void hub.runTask(Number(req.params.id), { model: b.model });
          return json({ ok: true });
        }),
      },
      "/api/approvals/:id": {
        POST: guard(async (req) => {
          const b = await body<{ approved?: boolean }>(req);
          const a = decideApproval(Number(req.params.id), Boolean(b.approved));
          hub.emit({ type: "tasks" });
          return json(a);
        }),
      },
      "/api/routines": {
        GET: guard(() => json(listRoutines())),
        POST: guard(async (req) => {
          const b = await body<{ name?: string; cron?: string; prompt?: string; cwd?: string }>(req);
          if (!b.name || !b.cron || !b.prompt) return bad("name, cron and prompt are required");
          return json(addRoutine(b.name, b.cron, b.prompt, b.cwd));
        }),
      },
      "/api/routines/:id": {
        DELETE: guard((req) => (removeRoutine(Number(req.params.id)), json({ ok: true }))),
        PATCH: guard(async (req) => {
          const b = await body<{ enabled?: boolean }>(req);
          setRoutineEnabled(Number(req.params.id), Boolean(b.enabled));
          return json({ ok: true });
        }),
      },
      "/api/memory": {
        GET: guard(() => json(listNotes(opts.cwd))),
        PUT: guard(async (req) => {
          const b = await body<{ name?: string; content?: string; scope?: Scope }>(req);
          if (!b.name || b.content === undefined) return bad("name and content are required");
          return json({ path: writeNote(b.name, b.content, b.scope ?? "global", opts.cwd) });
        }),
      },
      "/api/memory/:name": { DELETE: guard((req) => json({ path: removeNote(decodeURIComponent(req.params.name), opts.cwd) })) },
      "/api/skills": {
        GET: guard(() => json(listSkills(opts.cwd, true))),
        POST: guard(async (req) => {
          const b = await body<{ spec?: string }>(req);
          if (!b.spec) return bad("spec is required");
          return json(await addSkills(b.spec));
        }),
      },
      "/api/skills/:name/approve": { POST: guard((req) => json({ path: approveSkill(req.params.name) })) },
      "/api/skills/:name": { DELETE: guard((req) => json(removeSkill(decodeURIComponent(req.params.name), opts.cwd))) },
      "/api/compare": {
        POST: guard(async (req) => {
          const b = await body<{ prompt?: string; models?: string[] }>(req);
          if (!b.prompt || !b.models?.length) return bad("prompt and models are required");
          const { compareModels } = await import("./compare.ts");
          return json(await compareModels(b.prompt, b.models));
        }),
      },
      "/api/preview": guard((req) => {
        // Files the agent made, shown in a sandboxed iframe (open-design's live preview idea).
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || opts.cwd;
        const p = resolve(cwd, url.searchParams.get("path") ?? "");
        const rel = relative(cwd, p);
        if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(p) || !statSync(p).isFile()) return bad("Not a file in the working directory.", 404);
        return new Response(readFileSync(p), {
          headers: { "content-type": PREVIEW_TYPES[extname(p).toLowerCase()] ?? "application/octet-stream", "content-security-policy": "sandbox allow-scripts; default-src 'self' data: 'unsafe-inline'" },
        });
      }),
    },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (!sameOrigin(req)) return bad("Cross-site request refused.", 403);
        if (!authed(req)) return bad("Log in first.", 401);
        if (srv.upgrade(req, { data: {} })) return undefined;
        return bad("WebSocket upgrade failed");
      }
      return bad("Not found", 404);
    },
    websocket: {
      open(ws: ServerWebSocket<{ off?: () => void }>) {
        ws.data.off = hub.on((m: HubMessage) => ws.send(JSON.stringify(m)));
      },
      close(ws) {
        ws.data.off?.();
      },
      async message(ws, raw) {
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "chat") {
          hub
            .prompt({ text: String(msg.text ?? ""), sessionId: msg.sessionId as string | undefined, model: (msg.model as string) || undefined, cwd: (msg.cwd as string) || undefined, permissions: (msg.permissions as PermissionMode) || undefined, mode: msg.mode === "research" ? "research" : "default" })
            .catch((err: Error) => ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId, error: err.message })));
        } else if (msg.type === "abort") hub.abort(String(msg.sessionId));
        else if (msg.type === "approve") hub.answer(String(msg.id), (msg.answer as "yes" | "no" | "always") ?? "no");
      },
    },
  });
  return server;
}

export async function serveCommand(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { host: { type: "string" }, port: { type: "string" }, cwd: { type: "string" }, "no-scheduler": { type: "boolean" } } });
  const cfg = loadConfig();
  const host = values.host ?? cfg.server.host;
  const port = Number(values.port ?? process.env.PORT ?? cfg.server.port);
  let token = process.env.LVW_TOKEN ?? cfg.server.token;
  if (!LOOPBACK.has(host) && !token) {
    // Never listen on the network without a login.
    token = randomBytes(24).toString("base64url");
    cfg.server.token = token;
    saveConfig(cfg);
    console.log(`Created a login token (saved in ${ensureDirs().config}):\n  ${token}\n`);
  }
  const server = createServer({ host, port, token: LOOPBACK.has(host) ? process.env.LVW_TOKEN : token, cwd: values.cwd ?? process.cwd() });
  if (!values["no-scheduler"]) hub.startScheduler();
  console.log(`LvW web UI on http://${host === "0.0.0.0" ? "localhost" : host}:${server.port}  ${LOOPBACK.has(host) ? "(this machine only)" : "(login required)"}`);
}
