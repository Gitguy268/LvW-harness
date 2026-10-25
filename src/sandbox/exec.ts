/**
 * One execution entry point with swappable backends, after cloudflare/computer's
 * `workspace.runtime.exec(source, { backend })`: the host shell, or a Docker container
 * that mounts only the working directory.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecBackend {
  id: "host" | "docker";
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  dispose(): Promise<void>;
}

const MAX_OUTPUT = 30_000;

function clip(s: string) {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT / 2)}\n… [${s.length - MAX_OUTPUT} characters cut] …\n${s.slice(-MAX_OUTPUT / 2)}` : s;
}

async function run(argv: string[], cwd: string | undefined, opts: ExecOptions): Promise<ExecResult> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 120_000);
  const onAbort = () => proc.kill();
  opts.signal?.addEventListener("abort", onAbort);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  return { stdout: clip(stdout), stderr: clip(stderr), code, timedOut };
}

export function hostBackend(cwd: string): ExecBackend {
  return {
    id: "host",
    exec: (command, opts = {}) => run(["bash", "-lc", command], cwd, opts),
    dispose: async () => {},
  };
}

/** A long-lived container per session, so installed packages survive between commands. */
export function dockerBackend(cwd: string, image: string, network: "none" | "bridge"): ExecBackend {
  const name = `lvw-sbx-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let started: Promise<void> | undefined;
  const start = () =>
    (started ??= (async () => {
      const r = await run(["docker", "run", "-d", "--rm", "--name", name, `--network=${network}`, "-v", `${cwd}:/work`, "-w", "/work", image, "sleep", "infinity"], undefined, { timeoutMs: 300_000 });
      if (r.code !== 0) throw new Error(`Couldn't start the Docker sandbox: ${r.stderr.trim()}`);
    })());
  return {
    id: "docker",
    async exec(command, opts = {}) {
      await start();
      return run(["docker", "exec", "-w", "/work", name, "sh", "-lc", command], undefined, opts);
    },
    async dispose() {
      if (started) await run(["docker", "rm", "-f", name], undefined, { timeoutMs: 30_000 });
    },
  };
}
