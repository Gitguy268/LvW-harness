import { compactor } from "./compact.ts";
import { isNoToolsError, isTransientError, MAX_RETRIES, RETRY_BASE_MS, sleep } from "./resilience.ts";
import { listAgents } from "../skills/skills.ts";
import { offloadLargeOutput } from "../tools/offload.ts";
import { todoTool } from "../tools/todo.ts";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { loadConfig, type AgentMode, type Config, type PermissionMode } from "../config.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkpointLabel, type CheckpointStore } from "./checkpoints.ts";
import { gitCheckpoints } from "./checkpoints-git.ts";
import { detectChecks, failureBrief, summaryLine, type CheckResult } from "./checks.ts";
import { criticPrompt, parseVerdict, retryBrief } from "./critic.ts";
import { csvRecords, fillTemplate, toCsv } from "./csv.ts";
import { isUntrustedTool, UNTRUSTED_RULE, wrapUntrusted } from "./injection.ts";
import { ARCHITECT_PROMPT, editorBrief, MODES, modeModel, modePermissions } from "./modes.ts";
import { repoMapBudget } from "./repomap.ts";
import { repoMapFor } from "./repomap-fs.ts";
import { getDb } from "../db.ts";
import { paths } from "../paths.ts";
import { loadPlugins } from "../plugins/plugins.ts";
import { dockerBackend, hostBackend, type ExecBackend } from "../sandbox/exec.ts";
import { browserTools, closeBrowser, closeSpace } from "../tools/browser.ts";
import { fsTools } from "../tools/fs.ts";
import { knowledgeTools } from "../tools/knowledge.ts";
import { closeMcp, mcpTools } from "../tools/mcp.ts";
import { mediaTools } from "../tools/media.ts";
import { scrapeTools } from "../tools/scrape.ts";
import { taskTools } from "../tools/orchestra.ts";
import { shellTools } from "../tools/shell.ts";
import { defineTool, type LvwTool, type ToolContext } from "../tools/tool.ts";
import { webTools } from "../tools/web.ts";
import { decide, isReadOnlyCommand, summarize, type Asker } from "./permissions.ts";
import { buildSystemPrompt, type Mode } from "./prompt.ts";
import { attachVisionModel, audioPayload, resolveChatModel, type ResolvedChatModel } from "./providers.ts";

export interface SessionOptions {
  cwd: string;
  model?: string;
  resolved?: ResolvedChatModel;
  permissions?: PermissionMode;
  sandbox?: Config["sandbox"];
  /** How to ask the person for approval. Without it, anything that needs approval is refused. */
  ask?: Asker;
  /** Prompt flavour; "research" also picks research mode. */
  mode?: Mode;
  /** Code, Plan, Ask, Debug, Architect or Research (config.mode when left out). */
  agentMode?: AgentMode;
  sessionId?: string;
  depth?: number;
  taskId?: number;
  /** Only keep these tools (by name). */
  only?: string[];
  extraPrompt?: string;
  maxTurns?: number;
  maxTokens?: number;
  onStatus?: (s: string) => void;
  /** Extra tools from plugins, MCP servers or the browser. */
  extraTools?: (ctx: ToolContext) => Promise<LvwTool[]> | LvwTool[];
  persist?: boolean;
}

export interface Attachment {
  name?: string;
  mime: string;
  /** Base64 without the data: prefix. */
  data: string;
}

export type ToolFactory = (ctx: ToolContext) => Promise<LvwTool[]> | LvwTool[];
type Warn = (msg: string) => void;
const warned = new Set<string>();
const factories: ((ctx: ToolContext, warn: Warn) => Promise<LvwTool[]> | LvwTool[])[] = [
  (ctx) => (ctx.config.browser.enabled ? browserTools(ctx) : []),
  (ctx) => scrapeTools(ctx),
  (ctx) => mediaTools(ctx),
  (ctx, warn) => mcpTools(ctx.config.mcpServers, ctx.cwd, (name, err) => warn(`MCP server "${name}" didn't start: ${err.message}`)),
];
/** Add tools to every session from now on (what plugins do). */
export function registerToolFactory(f: ToolFactory) {
  factories.push(f);
}

// Plugins load once per plugins folder (tests and `LVW_HOME` changes get a fresh load).
const pluginLoads = new Map<string, Promise<void>>();
function loadPluginTools(warn: Warn) {
  const dir = paths().plugins;
  let load = pluginLoads.get(dir);
  if (!load) {
    load = loadPlugins((name, err) => warn(`plugin "${name}" didn't load: ${err.message}`)).then((list) => {
      for (const p of list) if (p.mod.tools) registerToolFactory(p.mod.tools);
    });
    pluginLoads.set(dir, load);
  }
  return load;
}

/** Close the shared browser and MCP servers so the process can exit. */
export async function shutdownTools() {
  await Promise.all([closeBrowser(), closeMcp()]);
}

export interface Usage {
  input: number;
  output: number;
  turns: number;
  cost: number;
}

/** Wrap outside text (web, browser, MCP) as untrusted data, with a warning when it looks like an injection. */
function guardUntrusted(tool: LvwTool): LvwTool {
  if (!isUntrustedTool(tool.name)) return tool;
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      const out = await tool.execute(id, params, signal, onUpdate);
      const source = String((params as { url?: string; query?: string })?.url ?? (params as { query?: string })?.query ?? tool.name);
      let flagged = false;
      const content = out.content.map((b) => {
        if (b.type !== "text") return b;
        const w = wrapUntrusted(source, b.text);
        flagged ||= w.scan.flagged;
        return { ...b, text: w.text };
      });
      return { ...out, content, details: flagged ? { ...(out.details as object | undefined), injectionWarning: true } : out.details };
    },
  };
}

export class Session {
  readonly id: string;
  readonly agent: Agent;
  readonly ctx: ToolContext;
  readonly tools: LvwTool[];
  readonly usage: Usage = { input: 0, output: 0, turns: 0, cost: 0 };
  stopReason?: string;
  readonly agentMode: AgentMode;
  readonly checkpoints?: CheckpointStore;
  /** The checkpoint taken before this turn's first change. */
  turnCheckpoint?: string;
  private changed = false;
  private turnLabel = "turn";
  private allowed = new Set<string>();
  private opts!: SessionOptions;

  private constructor(id: string, agent: Agent, ctx: ToolContext, tools: LvwTool[], private warn: Warn, agentMode: AgentMode, checkpoints?: CheckpointStore) {
    this.id = id;
    this.agent = agent;
    this.ctx = ctx;
    this.tools = tools;
    this.agentMode = agentMode;
    this.checkpoints = checkpoints;
  }

  static async create(opts: SessionOptions): Promise<Session> {
    const config = loadConfig();
    const agentMode: AgentMode = opts.agentMode ?? (opts.mode === "research" ? "research" : opts.mode === "subagent" ? "code" : config.mode);
    const resolved = opts.resolved ?? (await resolveChatModel(opts.model ?? modeModel(agentMode, config.modes, config.model), opts.onStatus));
    const sandbox = opts.sandbox ?? config.sandbox;
    const exec: ExecBackend = sandbox === "docker" ? dockerBackend(opts.cwd, config.sandboxImage, config.sandboxNetwork) : hostBackend(opts.cwd);
    const id = opts.sessionId ?? randomUUID();
    const depth = opts.depth ?? 0;
    const ctx: ToolContext = { cwd: opts.cwd, config, exec, sessionId: id, model: resolved, depth, taskId: opts.taskId };

    let tools: LvwTool[] = [...fsTools(ctx), ...shellTools(ctx), ...webTools(ctx), ...knowledgeTools(ctx), ...taskTools(ctx)];
    if (depth === 0) tools.push(subagentTool(ctx, opts), fanOutTool(ctx, opts), todoTool());
    tools.push(repoMapTool(ctx));
    // Each problem is reported once per process, not on every new chat.
    const warn: Warn = (msg) => {
      if (warned.has(msg)) return;
      warned.add(msg);
      opts.onStatus ? opts.onStatus(msg) : console.error(msg);
    };
    await loadPluginTools(warn);
    for (const f of factories) tools.push(...(await f(ctx, warn)));
    if (opts.extraTools) tools.push(...(await opts.extraTools(ctx)));
    if (opts.only) tools = tools.filter((t) => opts.only!.includes(t.name));
    tools = tools.map((t) => offloadLargeOutput(guardUntrusted(t), id, resolved.model.contextWindow));

    const saved = opts.sessionId ? loadMessages(opts.sessionId) : undefined;
    const mode = modePermissions(agentMode, opts.permissions ?? config.permissions);
    const spec = MODES[agentMode];
    const budget = depth === 0 && spec.repoMap ? repoMapBudget(resolved.model.contextWindow) : 0;
    const map = budget ? repoMapFor(opts.cwd, budget) : "";
    const extra = [
      spec.prompt,
      UNTRUSTED_RULE,
      map && `<repo_map note="files and their main symbols, most-used first; read files before changing them">\n${map}\n</repo_map>`,
      opts.extraPrompt,
    ].filter(Boolean).join("\n\n");
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt({ cwd: opts.cwd, mode: agentMode === "research" ? "research" : opts.mode === "subagent" ? "subagent" : "default", extra, tools: tools.map((t) => t.name), skillChars: resolved.model.contextWindow <= 16_384 ? 110 : 300 }),
        model: resolved.model,
        tools,
        messages: saved ?? [],
      },
      transformContext: compactor((context, signal) => resolved.models.completeSimple(resolved.model, context, { signal }), resolved.model.contextWindow),
      streamFn: resolved.models.streamSimple.bind(resolved.models),
      onPayload: resolved.senses?.hears ? (payload) => audioPayload(payload) : undefined,
      sessionId: id,
      identity: { attribution: null },
      toolExecution: "sequential",
    });
    const checkpoints = depth === 0 && mode !== "readonly" ? gitCheckpoints(opts.cwd) : undefined;
    const session = new Session(id, agent, ctx, tools, warn, agentMode, checkpoints);
    session.opts = { ...opts, permissions: mode };

    agent.beforeToolCall = async ({ toolCall, args }) => {
      const tool = tools.find((t) => t.name === toolCall.name);
      if (!tool) return undefined;
      const a = (args ?? {}) as Record<string, unknown>;
      const d = decide(mode, tool.risk, tool.name, a, opts.cwd);
      const changes = tool.risk === "write" || (tool.risk === "exec" && !isReadOnlyCommand(String(a.command ?? "")));
      if (d.action === "deny") return { block: true, reason: d.reason };
      if (d.action !== "allow" && !session.allowed.has(tool.name)) {
        if (!opts.ask) return { block: true, reason: "This needs the user's approval and nobody can answer here. Rerun with --yes or --auto, or explain what you would do." };
        const answer = await opts.ask({ tool: tool.name, summary: summarize(tool.name, a), args: a });
        if (answer === "always") session.allowed.add(tool.name);
        if (answer === "no") return { block: true, reason: "The user declined this action. Ask what they want instead, or take another approach." };
      }
      if (changes) await session.beforeChange();
      return undefined;
    };

    const maxTurns = opts.maxTurns ?? config.budgets.maxTurns;
    const maxTokens = opts.maxTokens ?? config.budgets.maxTokens;
    agent.subscribe(async (ev) => {
      if (ev.type === "message_end" && ev.message.role === "assistant") {
        const u = ev.message.usage;
        session.usage.input += u?.input ?? 0;
        session.usage.output += u?.output ?? 0;
        session.usage.cost += u?.cost?.total ?? 0;
      }
      if (ev.type === "turn_end") {
        session.usage.turns++;
        if (session.usage.turns >= maxTurns || session.usage.input + session.usage.output >= maxTokens) {
          session.stopReason = session.usage.turns >= maxTurns ? `turn budget (${maxTurns}) reached` : `token budget (${maxTokens}) reached`;
          agent.abort();
        }
      }
      if (ev.type === "agent_end" && opts.persist !== false && depth === 0) saveMessages(id, opts.cwd, resolved.model.id, agent.state.messages);
    });
    return session;
  }

  subscribe(fn: (ev: AgentEvent) => void | Promise<void>) {
    return this.agent.subscribe(fn);
  }

  /**
   * Send a message. Pictures go to models that see; audio goes to models that hear and is
   * transcribed for the rest, so a voice note always reaches the model as something it reads.
   */
  /** Snapshot the folder once per turn, before the first change. */
  async beforeChange() {
    this.changed = true;
    if (this.turnCheckpoint || !this.checkpoints) return;
    const cp = await this.checkpoints.snapshot(this.turnLabel);
    this.turnCheckpoint = cp?.id;
  }

  async prompt(text: string, attachments: Attachment[] = []) {
    this.stopReason = undefined;
    this.changed = false;
    this.turnCheckpoint = undefined;
    this.turnLabel = checkpointLabel(text);
    if (this.agentMode === "architect" && this.ctx.depth === 0 && text.trim()) text = await this.architect(text);
    const answer = await this.promptOnce(text, attachments);
    if (this.ctx.depth > 0 || this.stopReason) return answer;
    await this.runChecks();
    if (this.ctx.config.critic.enabled && !this.stopReason) await this.critique(text);
    return lastAssistantText(this.agent.state.messages);
  }

  /** Aider-style architect: a planner (read-only, its own model) writes the plan this session carries out. */
  private async architect(task: string): Promise<string> {
    const plannerRef = this.ctx.config.modes.architect?.model;
    this.warn(`Architect: planning${plannerRef ? ` with ${plannerRef}` : ""}…`);
    const planner = await Session.create({
      cwd: this.ctx.cwd,
      model: plannerRef,
      resolved: plannerRef ? undefined : this.ctx.model,
      agentMode: "plan",
      mode: "subagent",
      extraPrompt: ARCHITECT_PROMPT,
      depth: this.ctx.depth + 1,
      maxTurns: 25,
      persist: false,
    });
    try {
      const plan = await planner.prompt(task);
      return plan.trim() ? editorBrief(task, plan) : task;
    } finally {
      await planner.dispose();
    }
  }

  /** Run the test and lint commands after a turn that changed files; failures go back to the agent. */
  async runChecks(force = false): Promise<CheckResult[]> {
    const cfg = this.ctx.config.checks;
    if (!force && (!this.changed || !cfg.auto || this.opts.permissions === "readonly")) return [];
    const cmds = await detectChecks({ read: async (n) => (existsSync(join(this.ctx.cwd, n)) ? readFileSync(join(this.ctx.cwd, n), "utf8") : undefined) }, { test: cfg.test, lint: cfg.lint });
    const list = (["lint", "test"] as const).filter((k) => cmds[k]).map((k) => ({ name: k, command: cmds[k]! }));
    if (!list.length) return [];
    let results: CheckResult[] = [];
    for (let round = 1; round <= Math.max(1, cfg.maxRounds); round++) {
      results = [];
      for (const c of list) {
        if (!(await this.approveCheck(c.command))) return results;
        this.warn(`Checking: $ ${c.command}`);
        const r = await this.ctx.exec.exec(c.command, { timeoutMs: 10 * 60_000 });
        results.push({ ...c, ok: r.code === 0 && !r.timedOut, output: [r.stdout, r.stderr].filter(Boolean).join("\n") });
      }
      this.warn(`Checks: ${summaryLine(results)}`);
      if (results.every((r) => r.ok) || round === cfg.maxRounds || this.stopReason) break;
      await this.promptOnce(failureBrief(results, round, cfg.maxRounds));
    }
    return results;
  }

  private async approveCheck(command: string) {
    const d = decide(this.opts.permissions ?? "ask", "exec", "bash", { command }, this.ctx.cwd);
    if (d.action === "allow" || this.allowed.has("bash") || this.allowed.has("checks")) return true;
    if (d.action === "deny" || !this.opts.ask) return false;
    const answer = await this.opts.ask({ tool: "checks", summary: `$ ${command}  (test/lint check)`, args: { command } });
    if (answer === "always") this.allowed.add("checks");
    return answer !== "no";
  }

  /** OpenHands-style critic: a second look at the result; one more round when it fails. */
  private async critique(task: string) {
    const ref = this.ctx.config.critic.model;
    const critic = ref ? await resolveChatModel(ref) : this.ctx.model;
    const diff = this.turnCheckpoint && this.checkpoints ? await this.checkpoints.diff(this.turnCheckpoint).catch(() => "") : "";
    const answer = lastAssistantText(this.agent.state.messages);
    this.warn("Critic: reviewing…");
    const reply = await critic.models.completeSimple(critic.model, { systemPrompt: "You are a careful code reviewer.", messages: [{ role: "user", content: criticPrompt(task, answer, diff), timestamp: Date.now() }] });
    const text = (reply.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("");
    const v = parseVerdict(text);
    this.warn(`Critic: ${v.pass ? "PASS" : "FAIL"}${v.notes ? ` ${v.notes.split("\n")[0].slice(0, 120)}` : ""}`);
    if (!v.pass) await this.promptOnce(retryBrief(v));
  }

  private async promptOnce(text: string, attachments: Attachment[] = []) {
    const senses = this.ctx.model.senses ?? { sees: false, hears: false };
    const blocks: { type: "image"; data: string; mimeType: string }[] = [];
    const notes: string[] = [];
    for (const a of attachments) {
      if (a.mime.startsWith("image/")) {
        if (!senses.sees && !this.ctx.config.visionModel) this.warn(`${this.ctx.model.label} can't see pictures, so it gets a note that one was attached. Set a vision model with \`lvw setup\` to fix that.`);
        blocks.push({ type: "image", data: a.data, mimeType: a.mime });
      } else if (a.mime.startsWith("audio/") && senses.hears) {
        blocks.push({ type: "image", data: a.data, mimeType: a.mime });
      } else if (a.mime.startsWith("audio/")) {
        const { make } = await import("../media/make.ts");
        const out = await make({ kind: "transcribe", audio: Buffer.from(a.data, "base64") });
        notes.push(`[Voice note${a.name ? ` ${a.name}` : ""}, transcribed]: ${out.text}`);
      } else notes.push(`[Attached file ${a.name ?? ""} (${a.mime}) can't be read here.]`);
    }
    const full = [...notes, text].filter(Boolean).join("\n\n");
    // A picture for a model that can't see goes to the vision model for this turn.
    const hasImage = blocks.some((b) => b.mimeType.startsWith("image/"));
    const vision = hasImage && !senses.sees ? await attachVisionModel(this.ctx.model, this.ctx.model.local ? (s) => this.warn(s) : undefined).catch((err: Error) => (this.warn(err.message), undefined)) : undefined;
    const chatModel = this.agent.state.model;
    if (vision) this.agent.state.model = vision;
    try {
      await this.agent.prompt(full, blocks.length ? blocks : undefined);
      await this.recover();
    } finally {
      this.agent.state.model = chatModel;
    }
    return lastAssistantText(this.agent.state.messages);
  }

  /** Retry a failed reply: transient provider errors with backoff, and once without tools for models that have none. */
  private async recover() {
    for (let attempt = 0; ; ) {
      const last = this.agent.state.messages.at(-1) as { role: string; stopReason?: string; errorMessage?: string } | undefined;
      if (last?.role !== "assistant" || last.stopReason !== "error") return;
      const error = last.errorMessage ?? "";
      if (isNoToolsError(error) && this.agent.state.tools.length) {
        this.warn(`${this.ctx.model.label} can't use tools, so this chat runs without them.`);
        this.agent.state.tools = [];
        // The tool declarations travel in the leading system message, so they have to leave it too.
        const [first, ...rest] = this.agent.state.messages;
        if (first?.role === "system") {
          const note = "\n\nThis model can't call tools here. Answer directly and don't mention tools.";
          this.agent.state.messages = [{ ...first, toolsAdded: undefined, content: `${this.agent.state.systemPrompt}${note}` }, ...rest];
        }
      } else if (attempt < MAX_RETRIES && isTransientError(error)) {
        await sleep(RETRY_BASE_MS * 2 ** attempt++);
        if (this.stopReason) return;
      } else return;
      this.agent.state.messages = this.agent.state.messages.slice(0, -1);
      await this.agent.continue();
    }
  }

  abort() {
    this.agent.abort();
  }

  async dispose() {
    await closeSpace(this.id);
    await this.ctx.exec.dispose();
  }
}

export function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role: string; content?: unknown; errorMessage?: string };
    if (m.role !== "assistant") continue;
    if (Array.isArray(m.content)) {
      const text = m.content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
      if (text.trim()) return text;
    }
    if (m.errorMessage) return `[error] ${m.errorMessage}`;
  }
  return "";
}

/** deer-flow-style delegation: a fresh agent with its own context and no further subagents. */
function subagentTool(parent: ToolContext, opts: SessionOptions): LvwTool {
  const named = listAgents(parent.cwd);
  const specialists = named.slice(0, 20).map((a) => `${a.name} (${a.description.slice(0, 80)})`).join("; ");
  return defineTool({
    name: "subagent",
    label: "Delegate",
    description: "Hand a self-contained subtask to a helper agent with a fresh context (research, reading many files, a side investigation). Returns its final answer." + (specialists ? ` Specialists for the agent field: ${specialists}` : ""),
    risk: "read",
    parameters: Type.Object({
      task: Type.String({ description: "Everything the helper needs to know; it can't see this conversation" }),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Limit the helper to these tool names" })),
      agent: Type.Optional(Type.String({ description: "A named specialist, if any are listed" })),
    }),
    async execute({ task, tools, agent }, signal) {
      const specialist = agent ? named.find((a) => a.name === agent) : undefined;
      if (agent && !specialist) throw new Error(`No agent "${agent}". Available: ${named.map((a) => a.name).join(", ")}`);
      const child = await Session.create({
        extraPrompt: specialist?.prompt,
        cwd: parent.cwd,
        resolved: parent.model,
        permissions: opts.permissions,
        ask: opts.ask,
        mode: "subagent",
        depth: parent.depth + 1,
        taskId: parent.taskId,
        only: tools,
        maxTurns: 20,
        persist: false,
      });
      signal?.addEventListener("abort", () => child.abort());
      try {
        const answer = await child.prompt(task);
        return answer || "(the helper returned nothing)";
      } finally {
        await child.dispose();
      }
    },
  });
}

function loadMessages(id: string): AgentMessage[] | undefined {
  const row = getDb().query("SELECT messages FROM sessions WHERE id = ?").get(id) as { messages: string } | null;
  return row ? (JSON.parse(row.messages) as AgentMessage[]) : undefined;
}

function saveMessages(id: string, cwd: string, model: string, messages: AgentMessage[]) {
  const firstUser = messages.find((m) => (m as { role: string }).role === "user") as { content: unknown } | undefined;
  const content = firstUser?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? "").join(" ") : "";
  const title = text.trim().slice(0, 80) || "chat";
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO sessions (id, title, cwd, model, messages, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(id) DO UPDATE SET messages = ?5, model = ?4, updated_at = ?6`,
    )
    .run(id, title, cwd, model, JSON.stringify(messages), now);
}

export function listSessions(limit = 30) {
  return getDb().query("SELECT id, title, cwd, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as {
    id: string;
    title: string;
    cwd: string;
    model: string;
    created_at: number;
    updated_at: number;
  }[];
}

export function getSessionMessages(id: string) {
  return loadMessages(id) ?? [];
}

export function deleteSession(id: string) {
  getDb().query("DELETE FROM sessions WHERE id = ?").run(id);
}

/** The repository map on demand (the prompt only carries it when the context window allows). */
function repoMapTool(ctx: ToolContext): LvwTool {
  return defineTool({
    name: "repo_map",
    label: "Repo map",
    description: "A condensed map of the working folder: source files and their main symbols, most-used first. Use it to find where things live before reading files.",
    risk: "read",
    parameters: Type.Object({ max_chars: Type.Optional(Type.Number({ description: "Default 8000" })) }),
    async execute({ max_chars }) {
      return repoMapFor(ctx.cwd, Math.min(40_000, Math.max(1000, max_chars ?? 8000))) || "No source files found here.";
    },
  });
}

/** Codex-style CSV fan-out: one helper agent per row, a few at a time; results come back as CSV. */
function fanOutTool(parent: ToolContext, opts: SessionOptions): LvwTool {
  return defineTool({
    name: "fan_out",
    label: "Fan out",
    description:
      "Run the same subtask for every row of a CSV with parallel helper agents. prompt_template uses {{column}} placeholders. Returns the CSV with a result column added. Use for batches of similar, independent work (one file, URL or item per row).",
    risk: "read",
    parameters: Type.Object({
      csv: Type.String({ description: "CSV text with a header row, or a path to a .csv file in the working folder" }),
      prompt_template: Type.String({ description: "The task for each row, e.g. 'Summarise {{url}} in one line'" }),
      concurrency: Type.Optional(Type.Number({ description: "Helpers at once, 1-6, default 3" })),
      result_column: Type.Optional(Type.String({ description: "Default 'result'" })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Limit the helpers to these tool names" })),
    }),
    async execute({ csv, prompt_template, concurrency, result_column, tools }, signal) {
      const p = join(parent.cwd, csv.trim());
      const text = !csv.includes("\n") && csv.trim().endsWith(".csv") && existsSync(p) ? readFileSync(p, "utf8") : csv;
      const { header, records } = csvRecords(text);
      if (!records.length) throw new Error("The CSV has a header but no rows.");
      if (records.length > 200) throw new Error(`${records.length} rows is too many for one fan-out (200 at most). Split it.`);
      const col = result_column ?? "result";
      const limit = Math.max(1, Math.min(6, Math.round(concurrency ?? 3)));
      let next = 0;
      const worker = async () => {
        while (next < records.length && !signal?.aborted) {
          const row = records[next++];
          const child = await Session.create({ cwd: parent.cwd, resolved: parent.model, permissions: opts.permissions, ask: opts.ask, mode: "subagent", depth: parent.depth + 1, taskId: parent.taskId, only: tools, maxTurns: 15, persist: false });
          signal?.addEventListener("abort", () => child.abort());
          try {
            row[col] = (await child.prompt(fillTemplate(prompt_template, row))).trim() || "(no answer)";
          } catch (err) {
            row[col] = `[error] ${(err as Error).message}`;
          } finally {
            await child.dispose();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, records.length) }, worker));
      return toCsv(header.includes(col) ? header : [...header, col], records);
    },
  });
}
