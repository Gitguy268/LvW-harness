import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs } from "../paths.ts";

/** A local engine server LvW started in the background (whisper-server, idol, …). */
export interface ProcState {
  pid: number;
  port: number;
  /** What it was started with, so a different model means a restart. */
  key: string;
}

const stateFile = (name: string) => join(ensureDirs().runtime, `proc-${name}.json`);
export const procLog = (name: string) => join(ensureDirs().logs, `${name}.log`);

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function procState(name: string): ProcState | undefined {
  if (!existsSync(stateFile(name))) return undefined;
  const s = JSON.parse(readFileSync(stateFile(name), "utf8")) as ProcState;
  if (alive(s.pid)) return s;
  rmSync(stateFile(name), { force: true });
}

export async function stopProc(name: string) {
  const s = procState(name);
  if (!s) return false;
  process.kill(s.pid, "SIGTERM");
  for (let i = 0; i < 50 && alive(s.pid); i++) await Bun.sleep(100);
  if (alive(s.pid)) process.kill(s.pid, "SIGKILL");
  rmSync(stateFile(name), { force: true });
  return true;
}

async function up(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Start a server (or reuse the one already running with the same key) and wait until
 * `healthPath` answers 200.
 */
export async function startProc(
  name: string,
  opts: { argv: string[]; port: number; key: string; healthPath: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number; label?: string; onStatus?: (s: string) => void },
): Promise<ProcState> {
  const running = procState(name);
  const health = `http://127.0.0.1:${opts.port}${opts.healthPath}`;
  if (running && running.key === opts.key && (await up(`http://127.0.0.1:${running.port}${opts.healthPath}`))) return running;
  if (running) await stopProc(name);
  const fd = openSync(procLog(name), "w");
  const child = spawn(opts.argv[0], opts.argv.slice(1), { cwd: opts.cwd, env: opts.env ?? (process.env as Record<string, string>), detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  const state: ProcState = { pid: child.pid!, port: opts.port, key: opts.key };
  writeFileSync(stateFile(name), JSON.stringify(state));
  opts.onStatus?.(`Loading ${opts.label ?? name}…`);
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    if (!alive(state.pid)) {
      rmSync(stateFile(name), { force: true });
      throw new Error(`${opts.label ?? name} exited while loading. Last log lines:\n${readFileSync(procLog(name), "utf8").split("\n").slice(-15).join("\n")}`);
    }
    if (await up(health)) return state;
    await Bun.sleep(500);
  }
  await stopProc(name);
  throw new Error(`${opts.label ?? name} didn't start in time. See ${procLog(name)}.`);
}
