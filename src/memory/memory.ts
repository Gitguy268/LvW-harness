import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getDb } from "../db.ts";
import { paths } from "../paths.ts";

/**
 * Memory is plain Markdown, after akitaonrails/ai-memory: files you can grep, edit and sync.
 * The SQLite FTS index is derived from them and rebuilt whenever a file changes.
 *   ~/.lvw/memory/          global (profile.md is shown to every session)
 *   <project>/.lvw/memory/  per project (handoff.md is shown when you return to the project)
 */
export type Scope = "global" | "project";

export interface MemoryNote {
  path: string;
  scope: Scope;
  name: string;
  title: string;
  body: string;
}

export const memoryDir = (scope: Scope, cwd: string) => (scope === "global" ? paths().memory : join(cwd, ".lvw", "memory"));

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "note";

function titleOf(body: string, fallback: string) {
  return /^name:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? fallback;
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

export function listNotes(cwd: string): MemoryNote[] {
  return (["global", "project"] as Scope[]).flatMap((scope) => {
    const dir = memoryDir(scope, cwd);
    return files(dir).map((p) => {
      const body = readFileSync(p, "utf8");
      const name = relative(dir, p).replace(/\.md$/, "");
      return { path: p, scope, name, title: titleOf(body, name), body };
    });
  });
}

/** Bring the FTS index in line with the files on disk. */
export function reindex(cwd: string) {
  const db = getDb();
  const known = new Map((db.query("SELECT path, mtime FROM memory_files").all() as { path: string; mtime: number }[]).map((r) => [r.path, r.mtime]));
  const seen = new Set<string>();
  db.transaction(() => {
    for (const scope of ["global", "project"] as Scope[]) {
      for (const p of files(memoryDir(scope, cwd))) {
        seen.add(p);
        const mtime = Math.floor(statSync(p).mtimeMs);
        if (known.get(p) === mtime) continue;
        const body = readFileSync(p, "utf8");
        db.query("DELETE FROM memory_fts WHERE path = ?").run(p);
        db.query("INSERT INTO memory_fts (path, title, body) VALUES (?, ?, ?)").run(p, titleOf(body, p), body);
        db.query("INSERT OR REPLACE INTO memory_files (path, mtime) VALUES (?, ?)").run(p, mtime);
      }
    }
    // Drop deleted files, but only those under the dirs we just scanned.
    const roots = [memoryDir("global", cwd), memoryDir("project", cwd)];
    for (const p of known.keys()) {
      if (!seen.has(p) && (roots.some((r) => p.startsWith(r)) || !existsSync(p))) {
        db.query("DELETE FROM memory_fts WHERE path = ?").run(p);
        db.query("DELETE FROM memory_files WHERE path = ?").run(p);
      }
    }
  })();
}

export function searchNotes(query: string, cwd: string, limit = 8) {
  reindex(cwd);
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length) return [];
  const match = terms.map((t) => `"${t}"`).join(" OR ");
  const roots = [memoryDir("global", cwd), memoryDir("project", cwd)];
  const rows = getDb()
    .query("SELECT path, title, snippet(memory_fts, 2, '[', ']', '…', 24) AS snippet FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?")
    .all(match, limit * 3) as { path: string; title: string; snippet: string }[];
  // Other projects' notes stay out of this project's results.
  return rows.filter((r) => roots.some((root) => r.path.startsWith(root))).slice(0, limit);
}

export function writeNote(name: string, content: string, scope: Scope, cwd: string) {
  const dir = memoryDir(scope, cwd);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${slug(name)}.md`);
  writeFileSync(p, content.endsWith("\n") ? content : content + "\n");
  return p;
}

export function removeNote(name: string, cwd: string) {
  const hit = listNotes(cwd).find((n) => n.name === name || n.name === slug(name));
  if (!hit) throw new Error(`No memory note "${name}".`);
  rmSync(hit.path);
  reindex(cwd);
  return hit.path;
}

/** What every session starts with: your profile and this project's last handoff. */
export function startupMemory(cwd: string): string {
  const parts: string[] = [];
  const profile = join(memoryDir("global", cwd), "profile.md");
  if (existsSync(profile)) parts.push(`<profile>\n${readFileSync(profile, "utf8").trim()}\n</profile>`);
  const handoff = join(memoryDir("project", cwd), "handoff.md");
  if (existsSync(handoff)) parts.push(`<last_handoff>\n${readFileSync(handoff, "utf8").trim()}\n</last_handoff>`);
  const notes = listNotes(cwd).filter((n) => !["profile", "handoff"].includes(n.name));
  if (notes.length) parts.push(`Memory notes you can search with memory_search: ${notes.slice(0, 30).map((n) => `${n.scope}/${n.name}`).join(", ")}`);
  return parts.join("\n\n");
}
