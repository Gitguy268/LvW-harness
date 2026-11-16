/**
 * The agent session in the browser. Mirrors src/core/session.ts: the same pi-agent-core loop,
 * prompts, modes, approvals, compaction, retries, injection guard, checkpoints, checks, critic
 * and architect; tools and storage are the browser's.
 */
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentMode, Config, PermissionMode } from "../../config.ts";
import { checkpointLabel, type CheckpointStore } from "../../core/checkpoints.ts";
import { failureBrief, summaryLine, type CheckResult } from "../../core/checks.ts";
import { compactor } from "../../core/compact.ts";
import { criticPrompt, parseVerdict, retryBrief } from "../../core/critic.ts";
import { csvRecords, fillTemplate, toCsv } from "../../core/csv.ts";
import { isUntrustedTool, UNTRUSTED_RULE, wrapUntrusted } from "../../core/injection.ts";
import { ARCHITECT_PROMPT, editorBrief, MODES, modeModel, modePermissions } from "../../core/modes.ts";
import { decideWith, isReadOnlyCommand, summarize, type Asker } from "../../core/policy.ts";
import { BASE_PROMPTS, environmentLine } from "../../core/prompt-text.ts";
import { repoMapBudget } from "../../core/repomap.ts";
import { isNoToolsError, isTransientError, MAX_RETRIES, RETRY_BASE_MS, sleep } from "../../core/resilience.ts";
import { defineTool, type LvwTool, type ToolContext } from "../../tools/tool.ts";
import { browserCheckpoints } from "./checkpoints.ts";
import { db, getSettings, type BrowserSettings } from "./db.ts";
import { ROOT, workspace } from "./files.ts";
import { attachVisionModel, resolveChatModel, type ResolvedChatModel } from "./llm.ts";
import { findModel, listModels } from "./models.ts";
import { allSkills, commonTools, repoMapText, searchMemory, shell, type BrowserToolContext } from "./tools.ts";
import { transcribe } from "./whisper.ts";

export interface Attachment {
  name?: string;
  mime: string;
  data: string;
}

export interface SessionOptions {
  sessionId?: string;
  model?: string;
  resolved?: ResolvedChatModel;
  agentMode?: AgentMode;
  permissions?: PermissionMode;
  ask?: Asker;
  onStatus?: (s: string) => void;
  depth?: number;
  extraPrompt?: string;
  only?: string[];
  maxTurns?: number;
  persist?: boolean;
  subagent?: boolean;
}

export interface SavedSession {
  id: string;
  title: string;
  cwd: string;
  model: string;
  messages: AgentMessage[];
  created_at: number;
  updated_at: number;
}

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

/** Big results keep their start and end; the model can ask for more with read_file / grep. */
function clipLarge(tool: LvwTool, contextWindow: number): LvwTool {
  if (["read_file", "load_skill", "todo"].includes(tool.name)) return tool;
  const limit = Math.min(20_000, Math.floor(contextWindow * 3.5 * 0.25));
  return {
    ...tool,
    execute: async (...args) => {
      const out = await tool.execute(...args);
      const text = out.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      if (text.length <= limit) return out;
      const part = Math.floor(limit / 2) - 100;
      return { ...out, content: [{ type: "text", text: `${text.slice(0, part)}\n\n… ${text.length - part * 2} characters left out …\n\n${text.slice(-part)}` }] };
    },
  };
}

async function systemPrompt(mode: AgentMode, opts: SessionOptions, tools: string[], contextWindow: number, settings: BrowserSettings) {
  const parts = [BASE_PROMPTS[mode === "research" ? "research" : opts.subagent ? "subagent" : "default"]];
  parts.push(environmentLine(ROOT, `a web browser (just-bash shell, ${workspace().label})`));
  if (!opts.subagent) {
    for (const f of ["AGENTS.md", "CLAUDE.md", ".lvw/AGENTS.md"]) {
      const p = `${ROOT}/${f}`;
      if (await workspace().fs.exists(p)) parts.push(`<project_rules file="${f}">\n${(await workspace().fs.readFile(p)).slice(0, 12_000)}\n</project_rules>`);
    }
    const profile = (await db.get<{ body: string }>("memory", "profile"))?.body;
    const handoff = (await db.get<{ body: string }>("memory", "handoff"))?.body;
    if (profile || handoff) parts.push(`<memory>\n${[profile && `profile:\n${profile}`, handoff && `last handoff:\n${handoff}`].filter(Boolean).join("\n\n").slice(0, 4000)}\n</memory>`);
    if (tools.includes("load_skill")) {
      const chars = contextWindow <= 16_384 ? 110 : 300;
      const skills = (await allSkills()).filter((s) => s.scope !== "draft").map((s) => `- ${s.name}: ${s.description.slice(0, chars)}`).join("\n");
      if (skills) parts.push(`<skills>\nSkills you can load with load_skill:\n${skills}\n</skills>`);
    }
  }
  const spec = MODES[mode];
  const budget = !opts.subagent && spec.repoMap ? repoMapBudget(contextWindow) : 0;
  const map = budget ? await repoMapText(budget) : "";
  for (const extra of [spec.prompt, UNTRUSTED_RULE, map && `<repo_map note="files and their main symbols, most-used first; read files before changing them">\n${map}\n</repo_map>`, opts.extraPrompt]) if (extra) parts.push(extra);
  void settings;
  return parts.join("\n\n");
}

export class BrowserSession {
  readonly usage = { input: 0, output: 0, turns: 0, cost: 0 };
  stopReason?: string;
  turnCheckpoint?: string;
  private changed = false;
  private turnLabel = "turn";
  private allowed = new Set<string>();

  private constructor(
    readonly id: string,
    readonly agent: Agent,
    readonly model: ResolvedChatModel,
    readonly agentMode: AgentMode,
    readonly permissions: PermissionMode,
    readonly settings: BrowserSettings,
    private opts: SessionOptions,
    readonly checkpoints?: CheckpointStore,
  ) {}

  private warn(s: string) {
    this.opts.onStatus?.(s);
  }

  static async create(opts: SessionOptions): Promise<BrowserSession> {
    const settings = await getSettings();
    const agentMode: AgentMode = opts.agentMode ?? settings.mode;
    const resolved = opts.resolved ?? (await resolveChatModel(opts.model ?? modeModel(agentMode, settings.modes, settings.model)));
    const id = opts.sessionId ?? crypto.randomUUID();
    const depth = opts.depth ?? 0;
    const permissions = modePermissions(agentMode, opts.permissions ?? settings.permissions);
    let session: BrowserSession | undefined;
    const ctx: BrowserToolContext = {
      cwd: ROOT,
      config: { searxngUrl: settings.searxngUrl } as Config,
      exec: { id: "host", exec: async (c) => { const r = await shell().exec(c); await workspace().flush(); return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: false }; }, dispose: async () => {} },
      sessionId: id,
      model: resolved as unknown as ToolContext["model"],
      depth,
      flush: () => workspace().flush(),
    };
    let tools: LvwTool[] = commonTools(ctx, settings);
    if (depth === 0) tools.push(subagentTool(opts, resolved), fanOutTool(opts, resolved));
    if ((await listModels()).some((m) => m.role === "transcribe")) tools.push(transcribeTool());
    if (opts.only) tools = tools.filter((t) => opts.only!.includes(t.name));
    tools = tools.map((t) => clipLarge(guardUntrusted(t), resolved.model.contextWindow));
    const saved = opts.sessionId ? (await db.get<SavedSession>("sessions", opts.sessionId))?.messages : undefined;
    const agent = new Agent({
      initialState: {
        systemPrompt: await systemPrompt(agentMode, opts, tools.map((t) => t.name), resolved.model.contextWindow, settings),
        model: resolved.model,
        tools,
        messages: saved ?? [],
      },
      transformContext: compactor((context, signal) => resolved.models.completeSimple(resolved.model, context, { signal }), resolved.model.contextWindow),
      streamFn: resolved.models.streamSimple.bind(resolved.models),
      sessionId: id,
      identity: { attribution: null },
      toolExecution: "sequential",
    });
    const checkpoints = depth === 0 && permissions !== "readonly" ? browserCheckpoints() : undefined;
    session = new BrowserSession(id, agent, resolved, agentMode, permissions, settings, opts, checkpoints);
    const s = session;
    agent.beforeToolCall = async ({ toolCall, args }) => {
      const tool = tools.find((t) => t.name === toolCall.name);
      if (!tool) return undefined;
      const a = (args ?? {}) as Record<string, unknown>;
      const d = decideWith((p) => !p.startsWith("/") || p.startsWith(ROOT), permissions, tool.risk, tool.name, a);
      const changes = tool.risk === "write" || (tool.risk === "exec" && !isReadOnlyCommand(String(a.command ?? "")));
      if (d.action === "deny") return { block: true, reason: d.reason };
      if (d.action !== "allow" && !s.allowed.has(tool.name)) {
        if (!opts.ask) return { block: true, reason: "This needs the user's approval and nobody can answer here." };
        const answer = await opts.ask({ tool: tool.name, summary: summarize(tool.name, a), args: a });
        if (answer === "always") s.allowed.add(tool.name);
        if (answer === "no") return { block: true, reason: "The user declined this action. Ask what they want instead, or take another approach." };
      }
      if (changes) await s.beforeChange();
      return undefined;
    };
    const maxTurns = opts.maxTurns ?? 40;
    agent.subscribe(async (ev) => {
      if (ev.type === "message_end" && ev.message.role === "assistant") {
        const u = ev.message.usage;
        s.usage.input += u?.input ?? 0;
        s.usage.output += u?.output ?? 0;
        s.usage.cost += u?.cost?.total ?? 0;
      }
      if (ev.type === "turn_end" && ++s.usage.turns >= maxTurns) {
        s.stopReason = `turn budget (${maxTurns}) reached`;
        agent.abort();
      }
      if (ev.type === "agent_end" && opts.persist !== false && depth === 0) await s.save();
    });
    return s;
  }

  subscribe(fn: (ev: AgentEvent) => void | Promise<void>) {
    return this.agent.subscribe(fn);
  }

  async save() {
    const msgs = this.agent.state.messages;
    const first = msgs.find((m) => (m as { role: string }).role === "user") as { content: unknown } | undefined;
    const c = first?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { text?: string }) => b.text ?? "").join(" ") : "";
    const prev = await db.get<SavedSession>("sessions", this.id);
    await db.put<SavedSession>("sessions", this.id, { id: this.id, title: prev?.title ?? (text.trim().slice(0, 80) || "chat"), cwd: ROOT, model: this.model.model.id, messages: msgs, created_at: prev?.created_at ?? Date.now(), updated_at: Date.now() });
  }

  async beforeChange() {
    this.changed = true;
    if (this.turnCheckpoint || !this.checkpoints) return;
    this.turnCheckpoint = (await this.checkpoints.snapshot(this.turnLabel))?.id;
  }

  async prompt(text: string, attachments: Attachment[] = []) {
    this.stopReason = undefined;
    this.changed = false;
    this.turnCheckpoint = undefined;
    this.turnLabel = checkpointLabel(text);
    if (this.agentMode === "architect" && !this.opts.depth && text.trim()) text = await this.architect(text);
    const answer = await this.promptOnce(text, attachments);
    if (this.opts.depth || this.stopReason) return answer;
    await this.runChecks();
    if (this.settings.critic.enabled && !this.stopReason) await this.critique(text);
    return lastAssistantText(this.agent.state.messages);
  }

  private async architect(task: string) {
    const plannerRef = this.settings.modes.architect?.model;
    this.warn(`Architect: planning${plannerRef ? ` with ${plannerRef}` : ""}…`);
    const planner = await BrowserSession.create({ model: plannerRef, resolved: plannerRef ? undefined : this.model, agentMode: "plan", subagent: true, extraPrompt: ARCHITECT_PROMPT, depth: 1, maxTurns: 25, persist: false });
    const plan = await planner.prompt(task);
    return plan.trim() ? editorBrief(task, plan) : task;
  }

  /** Only commands set in Settings: the browser shell has no npm, go or cargo to detect. */
  async runChecks(force = false): Promise<CheckResult[]> {
    const cfg = this.settings.checks;
    if (!force && (!this.changed || !cfg.auto || this.permissions === "readonly")) return [];
    const list = (["lint", "test"] as const).filter((k) => cfg[k]).map((k) => ({ name: k, command: cfg[k]! }));
    let results: CheckResult[] = [];
    for (let round = 1; round <= Math.max(1, cfg.maxRounds) && list.length; round++) {
      results = [];
      for (const c of list) {
        if (!(await this.approveCheck(c.command))) return results;
        this.warn(`Checking: $ ${c.command}`);
        const r = await shell().exec(c.command);
        await workspace().flush();
        results.push({ ...c, ok: r.exitCode === 0, output: [r.stdout, r.stderr].filter(Boolean).join("\n") });
      }
      this.warn(`Checks: ${summaryLine(results)}`);
      if (results.every((r) => r.ok) || round === cfg.maxRounds || this.stopReason) break;
      await this.promptOnce(failureBrief(results, round, cfg.maxRounds));
    }
    return results;
  }

  private async approveCheck(command: string) {
    const d = decideWith(() => true, this.permissions, "exec", "bash", { command });
    if (d.action === "allow" || this.allowed.has("bash") || this.allowed.has("checks")) return true;
    if (d.action === "deny" || !this.opts.ask) return false;
    const answer = await this.opts.ask({ tool: "checks", summary: `$ ${command}  (test/lint check)`, args: { command } });
    if (answer === "always") this.allowed.add("checks");
    return answer !== "no";
  }

  private async critique(task: string) {
    const ref = this.settings.critic.model;
    const critic = ref ? await resolveChatModel(ref) : this.model;
    const diff = this.turnCheckpoint && this.checkpoints ? await this.checkpoints.diff(this.turnCheckpoint).catch(() => "") : "";
    this.warn("Critic: reviewing…");
    const reply = await critic.models.completeSimple(critic.model, { systemPrompt: "You are a careful code reviewer.", messages: [{ role: "user", content: criticPrompt(task, lastAssistantText(this.agent.state.messages), diff), timestamp: Date.now() }] });
    const text = (reply.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { type: string; text?: string }) => b.text ?? "").join("");
    const v = parseVerdict(text);
    this.warn(`Critic: ${v.pass ? "PASS" : "FAIL"}${v.notes ? ` ${v.notes.split("\n")[0].slice(0, 120)}` : ""}`);
    if (!v.pass) await this.promptOnce(retryBrief(v));
  }

  private async promptOnce(text: string, attachments: Attachment[] = []) {
    const senses = this.model.senses ?? { sees: false, hears: false };
    const blocks: { type: "image"; data: string; mimeType: string }[] = [];
    const notes: string[] = [];
    for (const a of attachments) {
      if (a.mime.startsWith("image/")) blocks.push({ type: "image", data: a.data, mimeType: a.mime });
      else if (a.mime.startsWith("audio/")) {
        const whisper = (await listModels()).find((m) => m.role === "transcribe");
        if (!whisper) {
          notes.push("[A voice note was attached, but no speech-to-text model is downloaded. Get Whisper on the Models page.]");
          continue;
        }
        const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
        const out = await transcribe(whisper.name, bytes.buffer, { onStatus: (s) => this.warn(s) });
        notes.push(`[Voice note${a.name ? ` ${a.name}` : ""}, transcribed]: ${out.text}`);
      } else notes.push(`[Attached file ${a.name ?? ""} (${a.mime}) can't be read here.]`);
    }
    const full = [...notes, text].filter(Boolean).join("\n\n");
    const hasImage = blocks.length > 0;
    let vision;
    if (hasImage && !senses.sees) {
      vision = await attachVisionModel(this.model).catch((err: Error) => (this.warn(err.message), undefined));
      if (!vision) this.warn(`${this.model.label} can't see pictures, so it gets a note that one was attached. Set a vision model in Settings.`);
    }
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

  private async recover() {
    for (let attempt = 0; ; ) {
      const last = this.agent.state.messages.at(-1) as { role: string; stopReason?: string; errorMessage?: string } | undefined;
      if (last?.role !== "assistant" || last.stopReason !== "error") return;
      const error = last.errorMessage ?? "";
      if (isNoToolsError(error) && this.agent.state.tools.length) {
        this.warn(`${this.model.label} can't use tools, so this chat runs without them.`);
        this.agent.state.tools = [];
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

function subagentTool(opts: SessionOptions, resolved: ResolvedChatModel): LvwTool {
  return defineTool({
    name: "subagent",
    label: "Delegate",
    description: "Hand a self-contained subtask to a helper agent with a fresh context (research, reading many files, a side investigation). Returns its final answer.",
    risk: "read",
    parameters: Type.Object({
      task: Type.String({ description: "Everything the helper needs to know; it can't see this conversation" }),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Limit the helper to these tool names" })),
    }),
    async execute({ task, tools }, signal) {
      const child = await BrowserSession.create({ resolved, permissions: opts.permissions, ask: opts.ask, subagent: true, agentMode: "code", depth: 1, only: tools, maxTurns: 20, persist: false });
      signal?.addEventListener("abort", () => child.abort());
      return (await child.prompt(task)) || "(the helper returned nothing)";
    },
  });
}

function fanOutTool(opts: SessionOptions, resolved: ResolvedChatModel): LvwTool {
  return defineTool({
    name: "fan_out",
    label: "Fan out",
    description:
      "Run the same subtask for every row of a CSV with helper agents. prompt_template uses {{column}} placeholders. Returns the CSV with a result column added. Use for batches of similar, independent work.",
    risk: "read",
    parameters: Type.Object({
      csv: Type.String({ description: "CSV text with a header row, or a path to a .csv file in the working folder" }),
      prompt_template: Type.String({ description: "The task for each row, e.g. 'Summarise {{url}} in one line'" }),
      concurrency: Type.Optional(Type.Number({ description: "Helpers at once, 1-3 in the browser, default 1 for local models" })),
      result_column: Type.Optional(Type.String({ description: "Default 'result'" })),
    }),
    async execute({ csv, prompt_template, concurrency, result_column }, signal) {
      const p = `${ROOT}/${csv.trim()}`;
      const text = !csv.includes("\n") && csv.trim().endsWith(".csv") && (await workspace().fs.exists(p)) ? await workspace().fs.readFile(p) : csv;
      const { header, records } = csvRecords(text);
      if (!records.length) throw new Error("The CSV has a header but no rows.");
      if (records.length > 100) throw new Error(`${records.length} rows is too many for one fan-out in the browser (100 at most).`);
      const col = result_column ?? "result";
      // One in-page model answers one request at a time; hosted models can go wider.
      const limit = resolved.local ? 1 : Math.max(1, Math.min(3, Math.round(concurrency ?? 2)));
      let next = 0;
      const worker = async () => {
        while (next < records.length && !signal?.aborted) {
          const row = records[next++];
          const child = await BrowserSession.create({ resolved, permissions: opts.permissions, ask: opts.ask, subagent: true, agentMode: "code", depth: 1, maxTurns: 12, persist: false });
          try {
            row[col] = (await child.prompt(fillTemplate(prompt_template, row))).trim() || "(no answer)";
          } catch (err) {
            row[col] = `[error] ${(err as Error).message}`;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, records.length) }, worker));
      return toCsv(header.includes(col) ? header : [...header, col], records);
    },
  });
}

function transcribeTool(): LvwTool {
  return defineTool({
    name: "transcribe",
    label: "Transcribe",
    description: "Turn speech in an audio file from the working folder into text with Whisper (slow in the browser: about ten times the audio length).",
    risk: "read",
    parameters: Type.Object({ path: Type.String(), language: Type.Optional(Type.String()) }),
    async execute({ path, language }) {
      const m = (await listModels()).find((x) => x.role === "transcribe");
      if (!m) throw new Error("No Whisper model is downloaded.");
      const bytes = await workspace().fs.readFileBuffer(path.startsWith("/") ? path : `${ROOT}/${path}`);
      return (await transcribe(m.name, bytes.slice().buffer, { language })).text || "(no speech found)";
    },
  });
}

export { findModel, searchMemory };
