import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { Session, shutdownTools } from "../core/session.ts";
import type { Answer, Asker } from "../core/permissions.ts";
import type { ResolvedChatModel } from "../core/providers.ts";
import { getToken } from "../credentials.ts";
import { c, fail } from "../cli/ui.ts";

/**
 * Talk to LvW from your phone (an idea from openclaw and hermes-agent): a Telegram bot that long-polls
 * the Bot API, so it needs no public URL. Only chat ids in telegram.allowedChatIds get an agent; each
 * chat keeps its own session, and approvals arrive as Yes / Always / No buttons.
 */
export interface BotOptions {
  token: string;
  allowed: number[];
  cwd: string;
  model?: string;
  resolved?: ResolvedChatModel;
  /** Bot API base; tests point it at a fake server. */
  api?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
}

const LIMIT = 4000;

export function chunks(text: string, size = LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim() || "(no answer)";
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size) > size / 2 ? rest.lastIndexOf("\n", size) : size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

export async function runBot(o: BotOptions) {
  const base = `${o.api ?? "https://api.telegram.org"}/bot${o.token}`;
  const log = o.log ?? (() => {});
  const call = async <T = unknown>(method: string, body: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${base}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: o.signal });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  };
  const send = async (chat: number, text: string) => {
    for (const part of chunks(text)) await call("sendMessage", { chat_id: chat, text: part });
  };

  const sessions = new Map<number, Session>();
  const busy = new Set<number>();
  const pending = new Map<string, (a: Answer) => void>();

  const askIn = (chat: number): Asker => async (req) => {
    const id = randomUUID().slice(0, 8);
    const answer = new Promise<Answer>((resolve) => pending.set(id, resolve));
    await call("sendMessage", {
      chat_id: chat,
      text: `Allow ${req.tool}?\n${req.summary}`,
      reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: `${id}:yes` }, { text: "Always", callback_data: `${id}:always` }, { text: "No", callback_data: `${id}:no` }]] },
    });
    return answer;
  };

  const sessionFor = async (chat: number) => {
    let s = sessions.get(chat);
    if (!s) {
      s = await Session.create({ cwd: o.cwd, model: o.model, resolved: o.resolved, ask: askIn(chat), sessionId: `telegram-${chat}`, onStatus: log });
      sessions.set(chat, s);
    }
    return s;
  };

  const handle = async (chat: number, text: string) => {
    if (text === "/start") return send(chat, "Hi, I'm LvW. Send me a task. /new starts a fresh conversation, /stop cancels the current one.");
    if (text === "/stop") {
      sessions.get(chat)?.abort();
      return send(chat, "Stopped.");
    }
    if (text === "/new") {
      await sessions.get(chat)?.dispose();
      sessions.delete(chat);
      return send(chat, "Fresh conversation.");
    }
    if (busy.has(chat)) return send(chat, "Still working on your last message. /stop cancels it.");
    busy.add(chat);
    try {
      await call("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
      const s = await sessionFor(chat);
      const answer = await s.prompt(text);
      await send(chat, s.stopReason ? `${answer}\n\n(stopped: ${s.stopReason})` : answer);
    } catch (err) {
      await send(chat, `Error: ${(err as Error).message}`);
    } finally {
      busy.delete(chat);
    }
  };

  let offset = 0;
  try {
    while (!o.signal?.aborted) {
      let updates: Update[];
      try {
        updates = await call<Update[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      } catch (err) {
        if (o.signal?.aborted) break;
        log(`getUpdates failed: ${(err as Error).message}; retrying in 5 s`);
        await Bun.sleep(5000);
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) {
          const [id, answer] = (u.callback_query.data ?? "").split(":");
          const resolve = pending.get(id);
          pending.delete(id);
          resolve?.(answer as Answer);
          await call("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: resolve ? `Answered: ${answer}` : "This question has expired." }).catch(() => {});
          continue;
        }
        const chat = u.message?.chat.id;
        const text = u.message?.text?.trim();
        if (chat === undefined || !text) continue;
        if (!o.allowed.includes(chat)) {
          log(`ignored chat ${chat} (not in telegram.allowedChatIds)`);
          await send(chat, `This bot is private. To allow this chat, run on the LvW machine:\n  lvw config set telegram.allowedChatIds '[${chat}]'`);
          continue;
        }
        log(`chat ${chat}: ${text.slice(0, 80)}`);
        // Don't wait: approvals for this run arrive as later updates.
        void handle(chat, text);
      }
    }
  } finally {
    for (const s of sessions.values()) await s.dispose();
  }
}

export async function telegramCommand(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { model: { type: "string", short: "m" }, cwd: { type: "string" } } });
  const token = getToken("telegram") ?? fail("No bot token. Create a bot with @BotFather, then: lvw login telegram (or set LVW_TELEGRAM_TOKEN)");
  const allowed = loadConfig().telegram.allowedChatIds;
  if (!allowed.length) console.log(c.yellow("No chats allowed yet.") + " Message your bot once; it replies with the command that allows your chat.");
  const ctrl = new AbortController();
  process.once("SIGINT", () => ctrl.abort());
  console.log(`LvW Telegram bot is listening (${allowed.length} allowed chat${allowed.length === 1 ? "" : "s"}). Ctrl-C stops it.`);
  try {
    await runBot({ token, allowed, cwd: values.cwd ?? process.cwd(), model: values.model, signal: ctrl.signal, log: (m) => console.log(c.dim(m)) });
  } finally {
    await shutdownTools();
  }
}
