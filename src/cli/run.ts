import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Session, shutdownTools } from "../core/session.ts";
import { getTask, updateTask } from "../orchestra/tasks.ts";
import { parseAgentArgs } from "./agent-args.ts";
import { c, fail } from "./ui.ts";

/** Non-interactive: run one task to the end. Nothing asks; actions that need approval are refused unless --yes/--auto. */
export async function runCommand(argv: string[], mode: "default" | "research" = "default") {
  const a = parseAgentArgs(argv);
  let text = a.text;
  if (a.taskId) {
    const t = getTask(a.taskId) ?? fail(`No task #${a.taskId}`);
    text = `${t.title}\n\n${t.description}`.trim();
    updateTask(t.id, { status: "doing", owner: "lvw" });
  }
  if (!text && !process.stdin.isTTY) text = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!text) fail(mode === "research" ? 'lvw research "<question>"' : 'lvw run "<task>"');

  const session = await Session.create({
    cwd: a.cwd,
    model: a.model,
    permissions: a.permissions,
    sandbox: a.sandbox,
    mode,
    taskId: a.taskId,
    maxTurns: a.maxTurns,
    extraPrompt: a.extraPrompt,
    onStatus: (s) => !a.json && console.error(c.dim(s)),
  });
  const ctrl = () => session.abort();
  process.once("SIGINT", ctrl);
  session.subscribe((ev: AgentEvent) => {
    if (a.json) return void console.log(JSON.stringify(ev));
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") process.stdout.write(ev.assistantMessageEvent.delta);
    if (ev.type === "message_end" && ev.message.role === "assistant") {
      process.stdout.write("\n");
      const err = (ev.message as { errorMessage?: string }).errorMessage;
      if (err) console.error(c.red(`error: ${err}`));
    }
    if (ev.type === "tool_execution_start") console.error(c.cyan(`● ${ev.toolName}`) + c.dim(` ${JSON.stringify(ev.args).slice(0, 160)}`));
    if (ev.type === "tool_execution_end" && ev.isError) console.error(c.red(`  ✗ ${toolText(ev.result).slice(0, 300)}`));
  });
  try {
    const answer = await session.prompt(text);
    if (session.stopReason) console.error(c.yellow(`stopped: ${session.stopReason}`));
    if (a.taskId) updateTask(a.taskId, { status: session.stopReason ? "blocked" : "review", result: answer, addTokens: session.usage.input + session.usage.output });
    if (!a.json) console.error(c.dim(`${session.usage.turns} turns · ${session.usage.input + session.usage.output} tokens`));
  } finally {
    process.off("SIGINT", ctrl);
    await session.dispose();
    await shutdownTools();
  }
}

export function toolText(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  return (r?.content ?? []).map((b) => b.text ?? `[${b.type}]`).join("\n");
}
