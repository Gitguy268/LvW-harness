import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildRepoMap, isMappable, MAP_SKIP, type SourceFile } from "./repomap.ts";

const MAX_FILES = 3000;
const MAX_BYTES = 150_000;

/** Source files of a folder: git's file list when it is a repo (respects .gitignore), else a walk. */
export function collectSources(cwd: string): SourceFile[] {
  const dir = resolve(cwd);
  if (dir === resolve(homedir()) || dir === "/") return [];
  let paths: string[] = [];
  const git = Bun.which("git") ? Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: dir, stdout: "pipe", stderr: "ignore" }) : undefined;
  if (git?.exitCode === 0) paths = git.stdout.toString().split("\0").filter(Boolean);
  else {
    // Not a git repo: walk, but give up early in big folders (Downloads, /tmp, …).
    const deadline = Date.now() + 400;
    let seen = 0;
    const walk = (d: string) => {
      if (paths.length >= MAX_FILES || seen > 20_000 || Date.now() > deadline) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (++seen > 20_000) return;
        const p = join(d, e.name);
        const rel = relative(dir, p);
        if (e.name.startsWith(".") || MAP_SKIP.test(rel)) continue;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) paths.push(rel);
      }
    };
    try {
      walk(dir);
    } catch {}
  }
  const out: SourceFile[] = [];
  for (const rel of paths.filter(isMappable).slice(0, MAX_FILES)) {
    try {
      const p = join(dir, rel);
      if (statSync(p).size > MAX_BYTES) continue;
      out.push({ path: rel, text: readFileSync(p, "utf8") });
    } catch {}
  }
  return out;
}

export function repoMapFor(cwd: string, budgetChars: number): string {
  return budgetChars > 0 ? buildRepoMap(collectSources(cwd), budgetChars) : "";
}
