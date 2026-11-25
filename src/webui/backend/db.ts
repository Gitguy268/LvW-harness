/** A tiny promise wrapper around IndexedDB: one object store per collection, values keyed by id. */

const DB_NAME = "lvw-harness";
const STORES = ["kv", "sessions", "tasks", "routines", "memory", "recipes", "models", "media", "skills", "checkpoints"] as const;
export type StoreName = (typeof STORES)[number];

let opened: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const wrap = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => ((req.onsuccess = () => resolve(req.result)), (req.onerror = () => reject(req.error))));

async function store(name: StoreName, mode: IDBTransactionMode) {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const db = {
  async get<T>(s: StoreName, id: string): Promise<T | undefined> {
    return wrap((await store(s, "readonly")).get(id)) as Promise<T | undefined>;
  },
  async put<T>(s: StoreName, id: string, value: T): Promise<void> {
    await wrap((await store(s, "readwrite")).put(value, id));
  },
  async del(s: StoreName, id: string): Promise<void> {
    await wrap((await store(s, "readwrite")).delete(id));
  },
  async all<T>(s: StoreName): Promise<T[]> {
    return wrap((await store(s, "readonly")).getAll()) as Promise<T[]>;
  },
  async keys(s: StoreName): Promise<string[]> {
    return (await wrap((await store(s, "readonly")).getAllKeys())).map(String);
  },
};

/** Settings live under kv/settings. */
export interface BrowserSettings {
  model?: string;
  visionModel?: string;
  transcribeModel?: string;
  mode: import("../../config.ts").AgentMode;
  modes: import("../../config.ts").Config["modes"];
  checks: import("../../config.ts").Config["checks"];
  critic: import("../../config.ts").Config["critic"];
  permissions: import("../../config.ts").PermissionMode;
  keys: Record<string, string>;
  corsProxy?: string;
  searxngUrl?: string;
  ctx: number;
  gpu: boolean;
}

export const DEFAULT_SETTINGS: BrowserSettings = {
  mode: "code",
  modes: {},
  checks: { auto: false, maxRounds: 2 },
  critic: { enabled: false },
  permissions: "ask",
  keys: {},
  ctx: 16384,
  gpu: true,
};

export async function getSettings(): Promise<BrowserSettings> {
  const s = await db.get<Partial<BrowserSettings>>("kv", "settings");
  return { ...DEFAULT_SETTINGS, ...(s ?? {}), keys: { ...(s?.keys ?? {}) } };
}

export async function saveSettings(patch: Partial<BrowserSettings>) {
  const s = { ...(await getSettings()), ...patch };
  await db.put("kv", "settings", s);
  return s;
}
