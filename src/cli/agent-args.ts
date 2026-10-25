import { parseArgs } from "node:util";
import type { Config, PermissionMode } from "../config.ts";

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
    },
  });
  const permissions: PermissionMode | undefined = values.readonly ? "readonly" : values.auto || values.yes ? "auto" : undefined;
  const sandbox = values.sandbox as Config["sandbox"] | undefined;
  if (sandbox && sandbox !== "docker" && sandbox !== "host") throw new Error("--sandbox must be docker or host");
  return {
    model: values.model,
    permissions,
    sandbox,
    resume: values.resume,
    continue: values.continue,
    json: values.json,
    cwd: values.cwd ?? process.cwd(),
    taskId: values.task ? Number(values.task) : undefined,
    maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
    text: positionals.join(" "),
  };
}
