import { parseArgs } from "node:util";
import type { AgentMode, Config, PermissionMode } from "../config.ts";
import { isMode, MODE_IDS } from "../core/modes.ts";
import { loadProfile } from "../orchestra/improve.ts";

export function parseAgentArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m" },
      auto: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      readonly: { type: "boolean" },
      sandbox: { type: "string" },
      resume: { type: "string" },
      continue: { type: "boolean", short: "c" },
      json: { type: "boolean" },
      cwd: { type: "string" },
      task: { type: "string" },
      "max-turns": { type: "string" },
      profile: { type: "string" },
      mode: { type: "string" },
    },
  });
  const permissions: PermissionMode | undefined = values.readonly ? "readonly" : values.auto || values.yes ? "auto" : undefined;
  const sandbox = values.sandbox as Config["sandbox"] | undefined;
  if (sandbox && sandbox !== "docker" && sandbox !== "host") throw new Error("--sandbox must be docker or host");
  if (values.mode !== undefined && !isMode(values.mode)) throw new Error(`--mode must be one of ${MODE_IDS.join(", ")}`);
  return {
    model: values.model,
    permissions,
    sandbox,
    agentMode: values.mode as AgentMode | undefined,
    resume: values.resume,
    continue: values.continue,
    json: values.json,
    cwd: values.cwd ?? process.cwd(),
    taskId: values.task ? Number(values.task) : undefined,
    maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
    /** System prompt addition from a profile saved by lvw improve. */
    extraPrompt: values.profile ? loadProfile(values.profile).prompt || undefined : undefined,
    text: positionals.join(" "),
  };
}
