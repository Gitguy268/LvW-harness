import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

const CHARS_PER_TOKEN = 3.5;
/** Compact when the conversation passes this share of the window, and keep this share of recent turns. */
const TRIGGER = 0.7;
const KEEP = 0.3;
const SUMMARY_PROMPT = `Summarize this conversation so another assistant can carry on from here. Keep: the user's goal and requirements, decisions made, files and commands involved, results seen, and open tasks with their state. Leave out small talk. Reply with the summary only.`;

function textOf(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type: string; text?: string; name?: string; arguments?: unknown }) => (b.type === "text" ? b.text : b.type === "toolCall" ? `[${b.name} ${JSON.stringify(b.arguments)}]` : ""))
    .join("\n");
}

export function estimateTokens(messages: AgentMessage[]) {
  const size = (m: AgentMessage) => textOf(m).length + JSON.stringify((m as { toolsAdded?: unknown }).toolsAdded ?? "").length;
  return Math.ceil(messages.reduce((n, m) => n + size(m), 0) / CHARS_PER_TOKEN);
}

/** Where recent messages start. Never at a tool result, which would lose the call it answers. */
export function splitPoint(messages: AgentMessage[], keepTokens: number) {
  let kept = 0;
  let split = messages.length;
  for (let i = messages.length - 1; i > 0; i--) {
    kept += estimateTokens([messages[i]]);
    if (kept > keepTokens && split < messages.length) break;
    if ((messages[i] as { role: string }).role !== "toolResult") split = i;
  }
  return split;
}

const summaryMessage = (text: string): AgentMessage => ({ role: "user", content: `Summary of the earlier conversation:\n\n${text}`, timestamp: Date.now() }) as AgentMessage;

type Complete = (context: Context, signal?: AbortSignal) => Promise<AssistantMessage>;

/**
 * After deepagents and OpenHarness: when the context nears the model's window, replace older
 * turns with a summary. The agent's stored messages stay whole; only what the model sees shrinks.
 */
export function compactor(complete: Complete, contextWindow: number) {
  let summary: { count: number; text: string } | undefined;
  return async (all: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    // The leading system message holds the prompt and the tools, so it always stays.
    const lead = (all[0] as { role?: string } | undefined)?.role === "system" ? all.slice(0, 1) : [];
    const messages = all.slice(lead.length);
    // A retry or a reset can shorten the list below what was summarized.
    if (summary && summary.count > messages.length) summary = undefined;
    const view = () => [...lead, ...(summary ? [summaryMessage(summary.text), ...messages.slice(summary.count)] : messages)];
    if (estimateTokens(view()) < contextWindow * TRIGGER) return view();
    const start = summary?.count ?? 0;
    const recent = messages.slice(start);
    const split = splitPoint(recent, contextWindow * KEEP);
    if (split <= 0 || split >= recent.length) return view();
    const old = [...(summary ? [summaryMessage(summary.text)] : []), ...recent.slice(0, split)];
    const limit = Math.floor(contextWindow * 0.6 * CHARS_PER_TOKEN);
    const transcript = old.map((m) => `${(m as { role: string }).role}: ${textOf(m).slice(0, 4000)}`).join("\n\n").slice(-limit);
    let text = "";
    try {
      const reply = await complete({ systemPrompt: SUMMARY_PROMPT, messages: [{ role: "user", content: transcript, timestamp: Date.now() }] }, signal);
      if (reply.stopReason !== "error") text = reply.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
    } catch {}
    // A failed summary must not stop the chat: the older turns are dropped and the model is told so.
    summary = { count: start + split, text: text || "(Earlier messages were dropped to fit the context window; no summary is available.)" };
    return view();
  };
}
