import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionMode } from "../config.ts";
import { paths } from "../paths.ts";

/** How much a tool can change: read-only, files, shell, or the outside world (browser clicks, MCP). */
export type Risk = "read" | "write" | "exec" | "external";

export type Answer = "yes" | "no" | "always";
export interface ApprovalRequest {
  tool: string;
  summary: string;
  args: unknown;
}
export type Asker = (req: ApprovalRequest) => Promise<Answer>;

const SAFE_COMMANDS = new Set(
  "ls cat head tail wc pwd echo grep rg find which whereis date uname tree du df file stat sort uniq jq less true false env printenv basename dirname realpath diff cmp md5 shasum sha256sum node bun python3".split(" "),
);
const SAFE_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame"]);
const DANGEROUS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{/,
  /\bgit\s+push\b.*(--force|-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,
  />\s*\/dev\/(sd|disk|nvme)/,
  /\b(shutdown|reboot|halt)\b/,
  /\bchmod\s+-R\s+777\b/,
];

/** True when every part of a shell command only reads. */
export function isReadOnlyCommand(command: string): boolean {
  if (/[`<>]|\$\(/.test(command.replace(/2>&1|>\s*\/dev\/null/g, ""))) return false;
  return command
    .split(/&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .every((seg) => {
      const [cmd, sub] = seg.split(/\s+/);
      if (cmd === "git") return SAFE_GIT.has(sub ?? "");
      if (cmd === "find") return !/-(delete|exec|execdir|ok)\b/.test(seg);
      if (["node", "bun", "python3"].includes(cmd)) return /^\S+\s+(--version|-v)$/.test(seg);
      return SAFE_COMMANDS.has(cmd);
    });
}

export const isDangerousCommand = (command: string) => DANGEROUS.some((re) => re.test(command));

function insideAllowed(path: string, cwd: string) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return [cwd, paths().home].some((root) => {
    const rel = relative(root, abs);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}

export type Decision = { action: "allow" } | { action: "deny"; reason: string } | { action: "ask" };

export function decide(mode: PermissionMode, risk: Risk, tool: string, args: Record<string, unknown>, cwd: string): Decision {
  if (risk === "read") return { action: "allow" };
  if (risk === "write") {
    if (mode === "readonly") return { action: "deny", reason: "read-only mode: file changes are off" };
    const path = typeof args.path === "string" ? args.path : undefined;
    if (path && !insideAllowed(path, cwd)) return { action: "ask" };
    return mode === "auto" ? { action: "allow" } : { action: "ask" };
  }
  if (risk === "exec") {
    const command = String(args.command ?? "");
    if (isReadOnlyCommand(command)) return { action: "allow" };
    if (mode === "readonly") return { action: "deny", reason: "read-only mode: only read-only commands may run" };
    if (isDangerousCommand(command)) return { action: "ask" };
    return mode === "auto" ? { action: "allow" } : { action: "ask" };
  }
  if (mode === "readonly") return { action: "deny", reason: `read-only mode: ${tool} is off` };
  return mode === "auto" ? { action: "allow" } : { action: "ask" };
}

export function summarize(tool: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string") return `$ ${args.command}`;
  if (typeof args.path === "string") return `${tool} ${args.path}`;
  if (typeof args.url === "string") return `${tool} ${args.url}`;
  return `${tool} ${JSON.stringify(args).slice(0, 200)}`;
}
