import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolContext } from "./tool.ts";

export function shellTools(ctx: ToolContext) {
  return [
    defineTool({
      name: "bash",
      label: "Shell",
      description: `Run a shell command in the working directory${ctx.exec.id === "docker" ? " (inside a Docker sandbox mounted at /work)" : ""}. Returns stdout, stderr and the exit code. Don't start servers that never exit.`,
      risk: "exec",
      parameters: Type.Object({
        command: Type.String(),
        timeout_seconds: Type.Optional(Type.Number({ description: "Default 120" })),
      }),
      async execute({ command, timeout_seconds }, signal) {
        const r = await ctx.exec.exec(command, { timeoutMs: (timeout_seconds ?? 120) * 1000, signal });
        const parts = [r.stdout && r.stdout.trimEnd(), r.stderr && `[stderr]\n${r.stderr.trimEnd()}`, `[exit ${r.code}${r.timedOut ? ", timed out" : ""}]`].filter(Boolean);
        return parts.join("\n");
      },
    }),
  ];
}
