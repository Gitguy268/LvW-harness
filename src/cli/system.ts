import { existsSync, rmSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, setConfigValue } from "../config.ts";
import { getToken, setToken, type Service } from "../credentials.ts";
import { formatBytes, freeBytes } from "../models/disk.ts";
import { listModels } from "../models/registry.ts";
import { ensureDirs, paths } from "../paths.ts";
import { findLlamaServer, installLlama, installedBuilds, latestBuildTag, serverState } from "../runtime/llamacpp.ts";
import { ollamaAvailable } from "../runtime/ollama.ts";
import { askSecret, c, confirm, fail, progressBar, table } from "./ui.ts";

export async function runtimeCommand(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "install": {
      const variant = rest.find((a) => a.startsWith("--variant="))?.split("=")[1];
      const tag = rest.find((a) => a.startsWith("--tag="))?.split("=")[1];
      const bar = progressBar();
      const r = await installLlama({ tag, variant, onProgress: (d, t) => bar.update("llama.cpp", d, t ?? 0) });
      bar.end();
      console.log(`${c.green("installed")} llama.cpp ${r.tag}  ${c.dim(r.server)}`);
      return;
    }
    case "update": {
      const latest = await latestBuildTag();
      if (installedBuilds()[0] === latest) return console.log(`llama.cpp ${latest} is the newest build.`);
      return runtimeCommand(["install", `--tag=${latest}`]);
    }
    case "rm": {
      const dir = join(ensureDirs().runtime, "llama.cpp");
      rmSync(dir, { recursive: true, force: true });
      console.log("removed LvW's llama.cpp builds");
      return;
    }
    default: {
      const bin = findLlamaServer();
      const s = serverState();
      console.log(`llama-server  ${bin ? c.green(bin) : c.yellow("not installed (lvw runtime install)")}`);
      console.log(`running       ${s ? `${s.modelName} on :${s.port} (pid ${s.pid})` : c.dim("no")}`);
      console.log(`ollama        ${(await ollamaAvailable()) ? c.green(loadConfig().ollamaUrl) : c.dim("not running")}`);
    }
  }
}

export async function loginCommand(argv: string[], logout = false) {
  const service = argv[0] as Service;
  if (!["hf", "gh", "gl"].includes(service)) fail(`lvw ${logout ? "logout" : "login"} hf|gh|gl`);
  if (logout) {
    setToken(service, undefined);
    return console.log(`removed the ${service} token`);
  }
  const where = { hf: "https://huggingface.co/settings/tokens", gh: "https://github.com/settings/tokens", gl: "https://gitlab.com/-/user_settings/personal_access_tokens" }[service];
  console.log(c.dim(`Create a read-only token at ${where}`));
  const token = await askSecret("Token: ");
  if (!token) fail("no token given");
  setToken(service, token);
  console.log(`${c.green("saved")} to ${paths().credentials} (only you can read it)`);
}

export async function doctorCommand() {
  const p = ensureDirs();
  const free = freeBytes(p.home);
  const rows: string[][] = [];
  const check = (name: string, ok: boolean | "warn", detail: string) => rows.push([ok === true ? c.green("ok") : ok === "warn" ? c.yellow("!!") : c.red("--"), name, detail]);
  check("bun", true, Bun.version);
  check("home", true, p.home);
  check("disk", free > 10 * 1024 ** 3 ? true : "warn", `${formatBytes(free)} free${free < 10 * 1024 ** 3 ? " (keep models small)" : ""}`);
  check("memory", true, formatBytes(totalmem()));
  const bin = findLlamaServer();
  check("llama-server", bin ? true : "warn", bin ?? "missing: lvw runtime install");
  check("ollama", (await ollamaAvailable()) ? true : "warn", (await ollamaAvailable()) ? loadConfig().ollamaUrl : "not running (optional)");
  check("models", listModels().length ? true : "warn", `${listModels().length} downloaded`);
  check("default model", loadConfig().model ? true : "warn", loadConfig().model ?? "none: lvw model use <name>");
  const docker = Bun.which("docker");
  check("docker", docker ? true : "warn", docker ? "available for --sandbox docker" : "missing (optional sandbox)");
  check("git", Bun.which("git") ? true : "warn", Bun.which("git") ? "ok" : "missing: needed for skill add from git hosts");
  for (const s of ["hf", "gh", "gl"] as const) check(`${s} token`, getToken(s) ? true : "warn", getToken(s) ? "set" : "not set (only for gated/private models)");
  table(rows);
}

export function configCommand(argv: string[]) {
  const [cmd, key, value] = argv;
  if (cmd === "path") return console.log(paths().config);
  if (cmd === "set" && key && value !== undefined) {
    setConfigValue(key, value);
    return console.log(`${key} = ${value}`);
  }
  const cfg = loadConfig() as unknown as Record<string, unknown>;
  if (cmd === "get" && key) {
    const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], cfg);
    return console.log(typeof v === "object" ? JSON.stringify(v, null, 2) : String(v));
  }
  if (!existsSync(paths().config)) saveConfig(loadConfig());
  console.log(JSON.stringify({ ...cfg, server: { ...(cfg.server as object), token: (cfg.server as { token?: string }).token ? "(set)" : undefined } }, null, 2));
}

export async function setupCommand(argv: string[]) {
  const yes = argv.includes("--yes") || argv.includes("-y");
  ensureDirs();
  console.log(c.bold("LvW-harness setup\n"));
  if (!findLlamaServer()) {
    if (yes || (await confirm("Download llama.cpp (llama-server, about 30 MB)?", true))) await runtimeCommand(["install"]);
  } else console.log(`${c.green("ok")} llama-server found`);

  const { installBundledSkills } = await import("../skills/skills.ts");
  const n = installBundledSkills();
  if (n) console.log(`${c.green("ok")} installed ${n} bundled skills`);

  if (!listModels().length) {
    const spec = DEFAULT_MODEL;
    console.log(`\nThe suggested starter model is ${c.bold(spec)} (about 2.5 GB, good at tool calls).`);
    if (yes || (await confirm("Download it now?", true))) {
      const { modelCommand } = await import("./models.ts");
      await modelCommand(["pull", spec, "--yes"]);
      const first = listModels()[0];
      if (first) {
        const cfg = loadConfig();
        cfg.model = first.name;
        saveConfig(cfg);
      }
    }
  }
  console.log(`\nDone. Start chatting with ${c.bold("lvw chat")}, or open the web UI with ${c.bold("lvw serve")}.`);
}

export const DEFAULT_MODEL = "hf:unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M";
