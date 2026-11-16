import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { paths } from "../paths.ts";
import type { Checkpoint, CheckpointStore } from "./checkpoints.ts";

/** Big or generated folders a checkpoint skips (the project's own .gitignore applies too). */
const EXCLUDE = ["node_modules/", ".venv/", "venv/", "__pycache__/", "dist/", "build/", "target/", ".next/", ".cache/", "*.gguf", "*.safetensors", "*.bin", "*.onnx", "*.zip", "*.tar.gz", "*.mp4", "*.iso", "*.dmg"];

const MAX_FILES = 20_000;
const MAX_TOTAL = 500 * 1024 ** 2;
const MAX_FILE = 20 * 1024 ** 2;

/**
 * Checkpoints in a shadow git repository under ~/.lvw/checkpoints, with the project folder as
 * its work tree. The project's own .git is never read or written.
 */
export function gitCheckpoints(cwd: string): CheckpointStore | undefined {
  const dir = resolve(cwd);
  // Snapshotting a whole home folder or the disk root would be slow and huge.
  if (dir === resolve(homedir()) || dir === "/" || !Bun.which("git")) return undefined;
  const gitDir = join(paths().home, "checkpoints", createHash("sha1").update(dir).digest("hex").slice(0, 16));

  // Async, so a snapshot of a big folder never blocks the web server or a chat.
  const git = async (args: string[], allowFail = false) => {
    const p = Bun.spawn(["git", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "user.name=LvW", "-c", "user.email=lvw@localhost", `--git-dir=${gitDir}`, `--work-tree=${dir}`, ...args], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0 && !allowFail) throw new Error(`checkpoint git ${args[0]} failed: ${err.trim().slice(0, 300)}`);
    return out;
  };

  const ensure = async () => {
    if (existsSync(join(gitDir, "HEAD"))) return;
    mkdirSync(gitDir, { recursive: true });
    await git(["init", "-q"]);
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), EXCLUDE.join("\n") + "\n");
    writeFileSync(join(gitDir, "lvw-worktree"), dir + "\n");
  };

  // Too big to copy on every first change: skip single huge files, give up on huge folders.
  let tooBig: boolean | undefined;
  const sizeCheck = async () => {
    if (tooBig !== undefined) return !tooBig;
    const files = (await git(["ls-files", "-z", "--others", "--cached", "--exclude-standard"], true)).split("\0").filter(Boolean);
    if (files.length > MAX_FILES) return !(tooBig = true);
    let total = 0;
    const huge: string[] = [];
    for (const f of files) {
      try {
        const n = statSync(join(dir, f)).size;
        if (n > MAX_FILE) huge.push(f);
        else total += n;
      } catch {}
    }
    if (huge.length) appendFileSync(join(gitDir, "info", "exclude"), huge.map((f) => "/" + f.replace(/([*?[\]!#])/g, "\\$1")).join("\n") + "\n");
    return !(tooBig = total > MAX_TOTAL);
  };

  const snapshot = async (label: string): Promise<Checkpoint | undefined> => {
    try {
      await ensure();
      if (!(await sizeCheck())) return undefined;
      await git(["add", "-A", "--", "."]);
      await git(["commit", "-q", "--allow-empty", "--no-verify", "-m", label]);
      const id = (await git(["rev-parse", "HEAD"])).trim();
      return { id, label, time: Date.now() };
    } catch {
      return undefined;
    }
  };

  return {
    snapshot,
    async list(limit = 30) {
      if (!existsSync(join(gitDir, "HEAD"))) return [];
      const out = (await git(["log", `-n${limit}`, "--format=%H%x09%ct%x09%s"], true)).trim();
      if (!out) return [];
      return out.split("\n").map((line) => {
        const [id, t, ...rest] = line.split("\t");
        return { id, time: Number(t) * 1000, label: rest.join("\t") };
      });
    },
    async restore(id: string) {
      await ensure();
      await git(["cat-file", "-e", `${id}^{commit}`]);
      const before = await snapshot(`before restoring ${id.slice(0, 8)}`);
      if (!before) throw new Error("Couldn't save the current state, so nothing was restored.");
      // Files that exist now but didn't at the checkpoint go away; the rest come back.
      const added = (await git(["diff", "--name-only", "--diff-filter=A", "-z", id, before.id])).split("\0").filter(Boolean);
      for (const rel of added) rmSync(join(dir, rel), { force: true });
      const changed = (await git(["diff", "--name-only", "-z", id, before.id])).split("\0").filter(Boolean).length;
      await git(["checkout", id, "--", "."], true);
      return { restored: changed - added.length, removed: added.length };
    },
    async diff(id: string) {
      await ensure();
      await git(["add", "-A", "--", "."]);
      return git(["diff", "--cached", "--stat", "--patch", "--no-color", id], true);
    },
  };
}
