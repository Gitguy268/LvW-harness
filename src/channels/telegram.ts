import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Session, shutdownTools, type Attachment } from "../core/session.ts";
import { toWav } from "../media/api.ts";
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
  message?: {
    chat: { id: number };
    text?: string;
    caption?: string;
    photo?: { file_id: string; width: number }[];
    voice?: { file_id: string; mime_type?: string };
    audio?: { file_id: string; mime_type?: string; file_name?: string };
  };
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
  /** Download a file the user sent. */
  const fetchFile = async (fileId: string) => {
    const f = await call<{ file_path: string }>("getFile", { file_id: fileId });
    const res = await fetch(`${o.api ?? "https://api.telegram.org"}/file/bot${o.token}/${f.file_path}`, { signal: o.signal });
    if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  };
  /** Send a picture, clip, sound or mesh the agent made. */
  const sendMedia = async (chat: number, m: { mime: string; path: string; kind: string }) => {
    const [method, field] = m.mime.startsWith("image/") ? ["sendPhoto", "photo"] : m.mime.startsWith("video/") && m.mime !== "video/webm" ? ["sendVideo", "video"] : m.mime.startsWith("audio/") ? ["sendAudio", "audio"] : ["sendDocument", "document"];
    const form = new FormData();
    form.append("chat_id", String(chat));
    form.append(field, new Blob([readFileSync(m.path)], { type: m.mime }), basename(m.path));
    const res = await fetch(`${base}/${method}`, { method: "POST", body: form, signal: o.signal });
    if (!((await res.json()) as { ok: boolean }).ok) await send(chat, `Made ${m.kind}: ${m.path}`);
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
      s.subscribe((ev) => {
        const media = ev.type === "tool_execution_end" && !ev.isError ? (ev.result as { details?: { media?: { mime: string; path: string; kind: string } } })?.details?.media : undefined;
        if (media && media.kind !== "transcribe") void sendMedia(chat, media).catch((err: Error) => log(`couldn't send media: ${err.message}`));
      });
      sessions.set(chat, s);
    }
    return s;
  };

  const handle = async (chat: number, text: string, files: Attachment[] = []) => {
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
      const answer = await s.prompt(text, files);
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
        const msg = u.message;
        const text = (msg?.text ?? msg?.caption ?? "").trim();
        const hasMedia = Boolean(msg?.photo?.length || msg?.voice || msg?.audio);
        if (chat === undefined || (!text && !hasMedia)) continue;
        if (!o.allowed.includes(chat)) {
          log(`ignored chat ${chat} (not in telegram.allowedChatIds)`);
          await send(chat, `This bot is private. To allow this chat, run on the LvW machine:\n  lvw config set telegram.allowedChatIds '[${chat}]'`);
          continue;
        }
        log(`chat ${chat}: ${text.slice(0, 80)}${hasMedia ? " [+media]" : ""}`);
        // Don't wait: approvals for this run arrive as later updates.
        void (async () => {
          const files: Attachment[] = [];
          try {
            if (msg?.photo?.length) {
              const best = msg.photo.reduce((a, b) => (b.width > a.width ? b : a));
              files.push({ name: "photo.jpg", mime: "image/jpeg", data: Buffer.from(await fetchFile(best.file_id)).toString("base64") });
            }
            const sound = msg?.voice ?? msg?.audio;
            // Voice notes are Ogg Opus; the local engines read WAV.
            if (sound) files.push({ name: "voice note", mime: "audio/wav", data: Buffer.from(await toWav(await fetchFile(sound.file_id))).toString("base64") });
          } catch (err) {
            return send(chat, `Couldn't read that: ${(err as Error).message}`);
          }
          await handle(chat, text, files);
        })();
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
