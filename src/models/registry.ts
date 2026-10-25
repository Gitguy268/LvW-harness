import { getDb } from "../db.ts";
import type { ModelRecord } from "./types.ts";

interface Row {
  id: string;
  name: string;
  source: string;
  spec: string;
  dir: string;
  files: string;
  main_file: string | null;
  size: number;
  format: string;
  added_at: number;
  last_used: number | null;
}

const toRecord = (r: Row): ModelRecord => ({
  id: r.id,
  name: r.name,
  source: r.source,
  spec: r.spec,
  dir: r.dir,
  files: JSON.parse(r.files),
  mainFile: r.main_file ?? undefined,
  size: r.size,
  format: r.format,
  addedAt: r.added_at,
  lastUsed: r.last_used ?? undefined,
});

export function listModels(): ModelRecord[] {
  return (getDb().query("SELECT * FROM models ORDER BY added_at DESC").all() as Row[]).map(toRecord);
}

/** Look up by exact name, id, or a unique case-insensitive prefix of the name. */
export function findModel(ref: string): ModelRecord | undefined {
  const db = getDb();
  const exact = db.query("SELECT * FROM models WHERE name = ?1 OR id = ?1").get(ref) as Row | null;
  if (exact) return toRecord(exact);
  const hits = db.query("SELECT * FROM models WHERE lower(name) LIKE lower(?1) || '%'").all(ref) as Row[];
  if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} models: ${hits.map((h) => h.name).join(", ")}`);
  return hits[0] ? toRecord(hits[0]) : undefined;
}

export function uniqueName(base: string): string {
  const db = getDb();
  let name = base;
  for (let i = 2; db.query("SELECT 1 FROM models WHERE name = ?").get(name); i++) name = `${base}-${i}`;
  return name;
}

export function saveModel(m: ModelRecord) {
  getDb()
    .query(
      `INSERT INTO models (id, name, source, spec, dir, files, main_file, size, format, added_at, last_used)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id) DO UPDATE SET name=?2, files=?6, main_file=?7, size=?8, format=?9`,
    )
    .run(m.id, m.name, m.source, m.spec, m.dir, JSON.stringify(m.files), m.mainFile ?? null, m.size, m.format, m.addedAt, m.lastUsed ?? null);
}

export function deleteModel(id: string) {
  getDb().query("DELETE FROM models WHERE id = ?").run(id);
}

export function touchModel(id: string) {
  getDb().query("UPDATE models SET last_used = ? WHERE id = ?").run(Date.now(), id);
}
