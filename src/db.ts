import { Database } from "bun:sqlite";
import { ensureDirs } from "./paths.ts";

const MIGRATIONS = [
  `CREATE TABLE models (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     source TEXT NOT NULL,
     spec TEXT NOT NULL,
     dir TEXT NOT NULL,
     files TEXT NOT NULL,
     main_file TEXT,
     size INTEGER NOT NULL,
     format TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     last_used INTEGER
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     title TEXT,
     cwd TEXT,
     model TEXT,
     messages TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE tasks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'todo',
     owner TEXT,
     parent_id INTEGER,
     budget_tokens INTEGER,
     used_tokens INTEGER NOT NULL DEFAULT 0,
     result TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE task_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id INTEGER NOT NULL,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL
   );
   CREATE TABLE approvals (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id INTEGER,
     session_id TEXT,
     question TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL,
     decided_at INTEGER
   );
   CREATE TABLE routines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     cron TEXT NOT NULL,
     prompt TEXT NOT NULL,
     cwd TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     last_run INTEGER
   );
   CREATE TABLE memory_files (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL);
   CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, title, body);`,
];

let db: Database | undefined;
let dbPath: string | undefined;

export function getDb(): Database {
  const p = ensureDirs();
  if (db && dbPath === p.db) return db;
  db = new Database(p.db, { create: true });
  dbPath = p.db;
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db!.exec(MIGRATIONS[i]);
      db!.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  return db;
}

export function closeDb() {
  db?.close();
  db = undefined;
}
