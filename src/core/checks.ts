/**
 * The test/lint loop (after Aider's /test and /lint): find the project's commands, run them
 * after a turn that changed files, and hand failures back to the agent until they pass or a
 * round limit is hit. Browser-safe: the caller reads files and runs commands.
 */

export interface CheckCommands {
  test?: string;
  lint?: string;
}

export interface ProjectFiles {
  /** Text of a file in the project root, or undefined when it isn't there. */
  read(name: string): Promise<string | undefined>;
}

/** Commands from config win; otherwise detect them from the project's build files. */
export async function detectChecks(files: ProjectFiles, configured: CheckCommands = {}): Promise<CheckCommands> {
  const out: CheckCommands = { ...configured };
  if (out.test && out.lint) return out;
  const pkg = await files.read("package.json");
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
      const runner = (await files.read("bun.lock")) !== undefined || (await files.read("bun.lockb")) !== undefined ? "bun run" : (await files.read("pnpm-lock.yaml")) !== undefined ? "pnpm run" : "npm run";
      const isPlaceholder = (s?: string) => !s || /no test specified/.test(s);
      if (!out.test && !isPlaceholder(scripts.test)) out.test = `${runner} test`;
      if (!out.lint && scripts.lint) out.lint = `${runner} lint`;
      if (!out.lint && scripts.typecheck) out.lint = `${runner} typecheck`;
    } catch {}
  }
  if (!out.test && (await files.read("go.mod")) !== undefined) {
    out.test = "go test ./...";
    out.lint ??= "go vet ./...";
  }
  if (!out.test && (await files.read("Cargo.toml")) !== undefined) {
    out.test = "cargo test --quiet";
    out.lint ??= "cargo check --quiet";
  }
  if (!out.test) {
    const py = (await files.read("pyproject.toml")) ?? (await files.read("setup.cfg")) ?? (await files.read("pytest.ini"));
    if (py !== undefined && /pytest/.test(py + ((await files.read("requirements-dev.txt")) ?? ""))) out.test = "python3 -m pytest -q";
    if (!out.lint && py !== undefined && /\[tool\.ruff\]/.test(py)) out.lint = "ruff check .";
  }
  if (!out.test) {
    const make = await files.read("Makefile");
    if (make && /^test:/m.test(make)) out.test = "make test";
    if (!out.lint && make && /^lint:/m.test(make)) out.lint = "make lint";
  }
  return out;
}

export interface CheckResult {
  name: "test" | "lint";
  command: string;
  ok: boolean;
  output: string;
}

const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n / 3)}\n… [cut] …\n${s.slice(-(2 * n) / 3)}` : s);

/** What the agent reads after a failed round. */
export function failureBrief(results: CheckResult[], round: number, maxRounds: number): string {
  const failed = results.filter((r) => !r.ok);
  return `[Checks, round ${round} of ${maxRounds}] ${failed.map((r) => r.name).join(" and ")} failed after your changes. Fix the cause, then stop; the checks run again automatically.

${failed.map((r) => `$ ${r.command}\n${clip(r.output.trim())}`).join("\n\n")}`;
}

export function summaryLine(results: CheckResult[]): string {
  return results.map((r) => `${r.name} ${r.ok ? "passed" : "failed"} (${r.command})`).join(", ");
}
