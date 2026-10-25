#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { c } from "./ui.ts";

const HELP = `${c.bold("lvw")} — LvW-harness ${pkg.version}, a local-first agent harness

${c.bold("Models")}
  lvw model search|info|pull|ls|rm|du|gc|run|stop|use   download, run and remove models
  lvw runtime [install|update|rm]                         llama.cpp runtime
  lvw login|logout hf|gh|gl                               tokens for gated or private models

${c.bold("Agent")}
  lvw chat [--model m] [--auto|--readonly] [--sandbox docker]   terminal chat
  lvw run "<task>" [--yes] [--json]                     one task, no questions
  lvw research "<question>"                             deep research report
  lvw serve [--host h] [--port p]                       web UI and API (default 127.0.0.1:7878)

${c.bold("Extras")}
  lvw skill ls|add|rm|show      lvw memory ls|search|add|rm
  lvw task add|ls|show|done|run lvw routine add|ls|rm
  lvw mcp ls                    lvw tool install scrapling
  lvw improve "<task>"          lvw telegram

${c.bold("Setup")}
  lvw setup [--yes]   lvw doctor   lvw config [get|set|path]   lvw version
`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "model":
    case "models":
      return (await import("./models.ts")).modelCommand(rest);
    case "pull":
      return (await import("./models.ts")).modelCommand(["pull", ...rest]);
    case "ls":
      return (await import("./models.ts")).modelCommand(["ls", ...rest]);
    case "rm":
      return (await import("./models.ts")).modelCommand(["rm", ...rest]);
    case "runtime":
      return (await import("./system.ts")).runtimeCommand(rest);
    case "login":
      return (await import("./system.ts")).loginCommand(rest);
    case "logout":
      return (await import("./system.ts")).loginCommand(rest, true);
    case "doctor":
      return (await import("./system.ts")).doctorCommand();
    case "config":
      return (await import("./system.ts")).configCommand(rest);
    case "setup":
      return (await import("./system.ts")).setupCommand(rest);
    case "chat":
      return (await import("./chat.ts")).chatCommand(rest);
    case "run":
      return (await import("./run.ts")).runCommand(rest);
    case "research":
      return (await import("./run.ts")).runCommand(rest, "research");
    case "improve":
      return (await import("./improve.ts")).improveCommand(rest);
    case "serve":
      return (await import("../server/server.ts")).serveCommand(rest);
    case "skill":
    case "skills":
      return (await import("./extras.ts")).skillCommand(rest);
    case "memory":
      return (await import("./extras.ts")).memoryCommand(rest);
    case "task":
    case "tasks":
      return (await import("./extras.ts")).taskCommand(rest);
    case "routine":
    case "routines":
      return (await import("./extras.ts")).routineCommand(rest);
    case "mcp":
      return (await import("./extras.ts")).mcpCommand(rest);
    case "tool":
      return (await import("./extras.ts")).toolCommand(rest);
    case "telegram":
      return (await import("../plugins/telegram.ts")).telegramCommand(rest);
    case "version":
    case "--version":
    case "-v":
      return console.log(pkg.version);
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(c.red("error: ") + (process.env.LVW_DEBUG ? err.stack : err.message));
  process.exit(1);
});
