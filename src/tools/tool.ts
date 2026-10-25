import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Risk } from "../core/permissions.ts";
import type { ResolvedChatModel } from "../core/providers.ts";
import type { ExecBackend } from "../sandbox/exec.ts";

export interface ToolContext {
  cwd: string;
  config: Config;
  exec: ExecBackend;
  sessionId: string;
  model: ResolvedChatModel;
  /** 0 for the main agent; subagents get depth + 1 and can't spawn further. */
  depth: number;
  taskId?: number;
}

export type LvwTool = AgentTool<any> & { risk: Risk };

export function defineTool<T extends TSchema>(def: {
  name: string;
  label: string;
  description: string;
  parameters: T;
  risk: Risk;
  execute: (params: Static<T>, signal?: AbortSignal) => Promise<string | AgentToolResult<unknown>>;
}): LvwTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    risk: def.risk,
    execute: async (_id, params, signal) => {
      const out = await def.execute(params as Static<T>, signal);
      return typeof out === "string" ? { content: [{ type: "text", text: out }], details: undefined } : out;
    },
  };
}
