/**
 * Checkpoints in the browser: copies of the workspace's files in IndexedDB, taken before the
 * agent's first change in a turn. Same interface as the native shadow-git store.
 */
import { checkpointLabel as _label, type Checkpoint, type CheckpointStore } from "../../core/checkpoints.ts";
import { db } from "./db.ts";
import { ROOT, workspace } from "./files.ts";

const KEEP = 25;
const MAX_BYTES = 60 * 1024 * 1024;

interface Snap extends Checkpoint {
  files: Record<string, Uint8Array>;
}

async function readAll(): Promise<Record<string, Uint8Array> | undefined> {
  const ws = workspace();
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  for (const p of ws.list()) {
    if (p.startsWith(".lvw/skills/")) continue;
    const st = await ws.fs.stat(`${ROOT}/${p}`);
    if (st.isDirectory) continue;
    total += st.size;
    if (total > MAX_BYTES) return undefined;
    out[p] = await ws.fs.readFileBuffer(`${ROOT}/${p}`);
  }
  return out;
}

const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A short unified-style diff: changed files with their removed and added lines. */
function diffText(from: Record<string, Uint8Array>, to: Record<string, Uint8Array>): string {
  const out: string[] = [];
  for (const p of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    if (same(from[p], to[p])) continue;
    out.push(`--- a/${p}\n+++ b/${p}`);
    const a = from[p] ? text(from[p]).split("\n") : [];
    const b = to[p] ? text(to[p]).split("\n") : [];
    // Trim the common head and tail; show what is left.
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    out.push(`@@ line ${s + 1} @@`, ...a.slice(s, a.length - e).map((l) => `-${l}`), ...b.slice(s, b.length - e).map((l) => `+${l}`));
  }
  return out.join("\n");
}

export const checkpointLabel = _label;

export function browserCheckpoints(): CheckpointStore {
  const list = async (limit = 30): Promise<Checkpoint[]> =>
    (await db.all<Snap>("checkpoints")).sort((a, b) => b.time - a.time).slice(0, limit).map(({ id, label, time }) => ({ id, label, time }));
  const snapshot = async (label: string): Promise<Checkpoint | undefined> => {
    const files = await readAll();
    if (!files) return undefined;
    const cp: Snap = { id: crypto.randomUUID().replace(/-/g, ""), label, time: Date.now(), files };
    await db.put("checkpoints", cp.id, cp);
    const all = (await db.all<Snap>("checkpoints")).sort((a, b) => b.time - a.time);
    for (const old of all.slice(KEEP)) await db.del("checkpoints", old.id);
    return { id: cp.id, label, time: cp.time };
  };
  return {
    snapshot,
    list,
    async restore(id) {
      const target = await db.get<Snap>("checkpoints", id);
      if (!target) throw new Error("That checkpoint is gone.");
      const before = await snapshot(`before restoring ${id.slice(0, 8)}`);
      if (!before) throw new Error("The workspace is too big to save first, so nothing was restored.");
      const ws = workspace();
      const now = (await db.get<Snap>("checkpoints", before.id))!.files;
      let restored = 0;
      let removed = 0;
      for (const p of Object.keys(now)) if (!(p in target.files)) (await ws.fs.rm(`${ROOT}/${p}`, { force: true }), removed++);
      for (const [p, bytes] of Object.entries(target.files)) {
        if (same(now[p], bytes)) continue;
        await ws.fs.mkdir(`${ROOT}/${p}`.slice(0, `${ROOT}/${p}`.lastIndexOf("/")), { recursive: true });
        await ws.fs.writeFile(`${ROOT}/${p}`, bytes);
        restored++;
      }
      await ws.flush();
      return { restored, removed };
    },
    async diff(id) {
      const target = await db.get<Snap>("checkpoints", id);
      if (!target) return "";
      return diffText(target.files, (await readAll()) ?? {});
    },
  };
}
