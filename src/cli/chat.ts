import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Container, Editor, Loader, Markdown, matchesKey, ProcessTerminal, Text, TuiMainScreen, type MarkdownTheme } from "@earendil-works/pi-tui";
import { createInterface } from "node:readline/promises";
import type { Answer, ApprovalRequest } from "../core/permissions.ts";
import { listSessions, Session } from "../core/session.ts";
import { parseAgentArgs } from "./agent-args.ts";
import { toolText } from "./run.ts";
import { c } from "./ui.ts";

const mdTheme: MarkdownTheme = {
  heading: (s) => c.bold(c.cyan(s)),
  link: c.blue,
  linkUrl: c.dim,
  code: c.yellow,
  codeBlock: (s) => s,
  codeBlockBorder: c.dim,
  quote: c.dim,
  quoteBorder: c.dim,
  hr: c.dim,
  listBullet: c.cyan,
  bold: c.bold,
  italic: (s) => `\x1b[3m${s}\x1b[23m`,
  strikethrough: (s) => `\x1b[9m${s}\x1b[29m`,
  underline: (s) => `\x1b[4m${s}\x1b[24m`,
};

const HELP = `/new  start over   /exit  quit   Esc  stop the agent   Ctrl+C twice  quit
Approvals: y = yes, n = no, a = always allow this tool for this chat`;

export async function chatCommand(argv: string[]) {
  const a = parseAgentArgs(argv);
  const resumeId = a.resume ?? (a.continue ? listSessions().find((s) => s.cwd === a.cwd)?.id : undefined);
  if (!process.stdout.isTTY || !process.stdin.isTTY) return plainChat(a, resumeId);

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const log = new Container();
  const status = new Text("", 0, 0);
  tui.addChild(log);
  tui.addChild(status);

  let pending: ((a: Answer) => void) | undefined;
  const ask = (req: ApprovalRequest) =>
    new Promise<Answer>((resolve) => {
      status.setText(`${c.yellow("Allow")} ${c.bold(req.summary.slice(0, 300))}${c.yellow("?")}  ${c.dim("[y]es  [n]o  [a]lways")}`);
      tui.requestRender();
      pending = (ans) => {
        pending = undefined;
        status.setText("");
        log.addChild(new Text(c.dim(`  ${ans === "no" ? "declined" : "allowed"}: ${req.summary.slice(0, 120)}`), 1, 0));
        tui.requestRender();
        resolve(ans);
      };
    });

  log.addChild(new Text(c.dim("Starting…"), 1, 0));
  tui.start();
  let session: Session;
  const make = (sessionId?: string) =>
    Session.create({
      cwd: a.cwd,
      model: a.model,
      permissions: a.permissions,
      sandbox: a.sandbox,
      ask,
      sessionId,
      onStatus: (s) => {
        status.setText(c.dim(s));
        tui.requestRender();
      },
    });
  try {
    session = await make(resumeId);
  } catch (err) {
    tui.stop();
    throw err;
  }
  log.clear();
  log.addChild(new Text(`${c.bold("LvW")} ${c.dim(`· ${session.ctx.model.label} · ${a.permissions ?? session.ctx.config.permissions} mode · ${session.ctx.exec.id} · /help`)}`, 1, 1));
  if (resumeId) log.addChild(new Text(c.dim(`resumed session ${resumeId} (${session.agent.state.messages.length} messages)`), 1, 0));

  const editor = new Editor(tui, {
    borderColor: c.dim,
    selectList: { selectedPrefix: c.cyan, selectedText: c.bold, description: c.dim, scrollInfo: c.dim, noMatch: c.dim },
  });
  tui.addChild(editor);
  tui.setFocus(editor);

  let current: Markdown | undefined;
  let currentText = "";
  const tools = new Map<string, Text>();
  let loader: Loader | undefined;
  const wire = (s: Session) =>
    s.subscribe((ev: AgentEvent) => {
      if (ev.type === "message_start" && ev.message.role === "assistant") {
        currentText = "";
        current = undefined;
      }
      if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
        currentText += ev.assistantMessageEvent.delta;
        if (!current) {
          current = new Markdown("", 1, 0, mdTheme);
          log.addChild(current);
        }
        current.setText(currentText);
      }
      if (ev.type === "message_end" && ev.message.role === "assistant" && (ev.message as { errorMessage?: string }).errorMessage) {
        log.addChild(new Text(c.red(`error: ${(ev.message as { errorMessage?: string }).errorMessage}`), 1, 0));
      }
      if (ev.type === "tool_execution_start") {
        const line = new Text(`${c.cyan("●")} ${c.bold(ev.toolName)} ${c.dim(JSON.stringify(ev.args).slice(0, 140))}`, 1, 0);
        tools.set(ev.toolCallId, line);
        log.addChild(line);
      }
      if (ev.type === "tool_execution_end") {
        const out = toolText(ev.result).split("\n").find((l) => l.trim()) ?? "";
        const line = tools.get(ev.toolCallId);
        line?.setText(`${ev.isError ? c.red("✗") : c.green("✓")} ${c.bold(ev.toolName)} ${c.dim(out.slice(0, 140))}`);
      }
      tui.requestRender();
    });
  let unwire = wire(session);

  let lastCtrlC = 0;
  tui.addInputListener((data) => {
    if (pending) {
      const k = data.toLowerCase();
      if (k === "y") pending("yes");
      else if (k === "a") pending("always");
      else if (k === "n" || matchesKey(data, "escape")) pending("no");
      return { consume: true };
    }
    if (matchesKey(data, "escape") && session.agent.state.isStreaming) {
      session.abort();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (session.agent.state.isStreaming) session.abort();
      else if (Date.now() - lastCtrlC < 1500) void quit();
      else {
        lastCtrlC = Date.now();
        status.setText(c.dim("Press Ctrl+C again to quit"));
        tui.requestRender();
      }
      return { consume: true };
    }
    return undefined;
  });

  const quit = async () => {
    tui.stop();
    await session.dispose();
    console.log(c.dim(`session ${session.id} · resume with: lvw chat --resume ${session.id}`));
    process.exit(0);
  };

  editor.onSubmit = async (input) => {
    const text = input.trim();
    if (!text) return;
    if (text === "/exit" || text === "/quit") return quit();
    if (text === "/help") {
      log.addChild(new Text(c.dim(HELP), 1, 0));
      return tui.requestRender();
    }
    if (text === "/new") {
      unwire();
      await session.dispose();
      session = await make();
      unwire = wire(session);
      log.clear();
      log.addChild(new Text(c.dim("New session."), 1, 0));
      return tui.requestRender();
    }
    log.addChild(new Text(`${c.bold(c.blue("you"))} ${text}`, 1, 1));
    editor.disableSubmit = true;
    loader = new Loader(tui, c.cyan, c.dim, "thinking…");
    tui.addChild(loader);
    loader.start();
    tui.requestRender();
    try {
      await session.prompt(text);
      if (session.stopReason) log.addChild(new Text(c.yellow(`stopped: ${session.stopReason}`), 1, 0));
    } catch (err) {
      log.addChild(new Text(c.red(`error: ${(err as Error).message}`), 1, 0));
    } finally {
      loader.stop();
      tui.removeChild(loader);
      editor.disableSubmit = false;
      status.setText(c.dim(`${session.usage.turns} turns · ${session.usage.input + session.usage.output} tokens`));
      tui.requestRender();
    }
  };
}

/** Line-based fallback when stdin/stdout aren't a terminal. */
async function plainChat(a: ReturnType<typeof parseAgentArgs>, resumeId?: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const session = await Session.create({ cwd: a.cwd, model: a.model, permissions: a.permissions, sandbox: a.sandbox, sessionId: resumeId });
  session.subscribe((ev) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") process.stdout.write(ev.assistantMessageEvent.delta);
    if (ev.type === "message_end" && ev.message.role === "assistant") process.stdout.write("\n");
  });
  for await (const line of rl) if (line.trim()) await session.prompt(line);
  await session.dispose();
}
