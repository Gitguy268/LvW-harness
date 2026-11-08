import { compactor } from "./compact.ts";
import { isNoToolsError, isTransientError, MAX_RETRIES, RETRY_BASE_MS, sleep } from "./resilience.ts";
import { listAgents } from "../skills/skills.ts";
import { offloadLargeOutput } from "../tools/offload.ts";
import { todoTool } from "../tools/todo.ts";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { loadConfig, type Config, type PermissionMode } from "../config.ts";
import { getDb } from "../db.ts";
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
import { decide, summarize, type Asker } from "./permissions.ts";
import { buildSystemPrompt, type Mode } from "./prompt.ts";
import { audioPayload, resolveChatModel, type ResolvedChatModel } from "./providers.ts";

export interface SessionOptions {
  cwd: string;
  model?: string;
  resolved?: ResolvedChatModel;
  permissions?: PermissionMode;
  sandbox?: Config["sandbox"];
  /** How to ask the person for approval. Without it, anything that needs approval is refused. */
  ask?: Asker;
  mode?: Mode;
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

let plugins: Promise<void> | undefined;
function loadPluginTools(warn: Warn) {
  return (plugins ??= loadPlugins((name, err) => warn(`plugin "${name}" didn't load: ${err.message}`)).then((list) => {
    for (const p of list) if (p.mod.tools) registerToolFactory(p.mod.tools);
  }));
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

export class Session {
  readonly id: string;
  readonly agent: Agent;
  readonly ctx: ToolContext;
  readonly tools: LvwTool[];
  readonly usage: Usage = { input: 0, output: 0, turns: 0, cost: 0 };
  stopReason?: string;
  private allowed = new Set<string>();

  private constructor(id: string, agent: Agent, ctx: ToolContext, tools: LvwTool[], private warn: Warn) {
    this.id = id;
    this.agent = agent;
    this.ctx = ctx;
    this.tools = tools;
  }

  static async create(opts: SessionOptions): Promise<Session> {
    const config = loadConfig();
    const resolved = opts.resolved ?? (await resolveChatModel(opts.model, opts.onStatus));
    const sandbox = opts.sandbox ?? config.sandbox;
    const exec: ExecBackend = sandbox === "docker" ? dockerBackend(opts.cwd, config.sandboxImage, config.sandboxNetwork) : hostBackend(opts.cwd);
    const id = opts.sessionId ?? randomUUID();
    const depth = opts.depth ?? 0;
    const ctx: ToolContext = { cwd: opts.cwd, config, exec, sessionId: id, model: resolved, depth, taskId: opts.taskId };

    let tools: LvwTool[] = [...fsTools(ctx), ...shellTools(ctx), ...webTools(ctx), ...knowledgeTools(ctx), ...taskTools(ctx)];
    if (depth === 0) tools.push(subagentTool(ctx, opts), todoTool());
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
    tools = tools.map((t) => offloadLargeOutput(t, id, resolved.model.contextWindow));

    const saved = opts.sessionId ? loadMessages(opts.sessionId) : undefined;
    const mode = opts.permissions ?? config.permissions;
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt({ cwd: opts.cwd, mode: opts.mode, extra: opts.extraPrompt, tools: tools.map((t) => t.name), skillChars: resolved.model.contextWindow <= 16_384 ? 110 : 300 }),
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
    const session = new Session(id, agent, ctx, tools, warn);

    agent.beforeToolCall = async ({ toolCall, args }) => {
      const tool = tools.find((t) => t.name === toolCall.name);
      if (!tool) return undefined;
      const a = (args ?? {}) as Record<string, unknown>;
      const d = decide(mode, tool.risk, tool.name, a, opts.cwd);
      if (d.action === "allow" || session.allowed.has(tool.name)) return undefined;
      if (d.action === "deny") return { block: true, reason: d.reason };
      if (!opts.ask) return { block: true, reason: "This needs the user's approval and nobody can answer here. Rerun with --yes or --auto, or explain what you would do." };
      const answer = await opts.ask({ tool: tool.name, summary: summarize(tool.name, a), args: a });
      if (answer === "always") session.allowed.add(tool.name);
      return answer === "no" ? { block: true, reason: "The user declined this action. Ask what they want instead, or take another approach." } : undefined;
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
  async prompt(text: string, attachments: Attachment[] = []) {
    this.stopReason = undefined;
    const senses = this.ctx.model.senses ?? { sees: false, hears: false };
    const blocks: { type: "image"; data: string; mimeType: string }[] = [];
    const notes: string[] = [];
    for (const a of attachments) {
      if (a.mime.startsWith("image/")) {
        if (!senses.sees) this.warn(`${this.ctx.model.label} can't see pictures, so it gets a note that one was attached.`);
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
    await this.agent.prompt(full, blocks.length ? blocks : undefined);
    await this.recover();
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
