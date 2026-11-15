/**
 * The working folder in the browser. just-bash's in-memory file system is what the shell and the
 * file tools use; every change is written through to a folder handle:
 *   - by default a "workspace" folder in this site's private storage (OPFS), kept between visits;
 *   - or a real folder on disk the user opened (File System Access, Chromium only).
 */
import { InMemoryFs } from "just-bash/browser";
import { db } from "./db.ts";

export const ROOT = "/workspace";
const MAX_LOAD = 200 * 1024 * 1024;
const SKIP = /(^|\/)(node_modules|\.git|\.venv|__pycache__|dist|build|target)(\/|$)/;

export interface Workspace {
  fs: InMemoryFs;
  label: string;
  kind: "browser" | "folder";
  /** Write changed paths (or all) to the backing folder. */
  flush(): Promise<void>;
  /** Every file under ROOT, relative. */
  list(): string[];
}

let dirty = new Set<string>();
let removed = new Set<string>();
let current: Workspace | undefined;

/** Record every change so flush() writes only what moved. */
function track(fs: InMemoryFs) {
  const wrap = <K extends keyof InMemoryFs>(name: K, paths: (...a: unknown[]) => { changed?: string[]; gone?: string[] }) => {
    const orig = (fs[name] as unknown as (...a: unknown[]) => Promise<unknown>).bind(fs);
    (fs as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const r = await orig(...args);
      const { changed = [], gone = [] } = paths(...args);
      for (const p of changed) (dirty.add(p), removed.delete(p));
      for (const p of gone) (removed.add(p), dirty.delete(p));
      return r;
    };
  };
  wrap("writeFile", (p) => ({ changed: [String(p)] }));
  wrap("appendFile", (p) => ({ changed: [String(p)] }));
  wrap("rm", (p) => ({ gone: [String(p)] }));
  wrap("mv", (a, b) => ({ gone: [String(a)], changed: [String(b)] }));
  wrap("cp", (_a, b) => ({ changed: [String(b)] }));
  wrap("mkdir", (p) => ({ changed: [String(p)] }));
}

const rel = (p: string) => (p.startsWith(ROOT + "/") ? p.slice(ROOT.length + 1) : p === ROOT ? "" : p.replace(/^\/+/, ""));

async function dirFor(root: FileSystemDirectoryHandle, path: string, create: boolean) {
  let d = root;
  for (const part of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}

async function loadInto(fs: InMemoryFs, handle: FileSystemDirectoryHandle, prefix = "") {
  let total = 0;
  const walk = async (d: FileSystemDirectoryHandle, at: string) => {
    for await (const [name, h] of d as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      const p = at ? `${at}/${name}` : name;
      if (SKIP.test(p)) continue;
      if (h.kind === "directory") {
        await fs.mkdir(`${ROOT}/${p}`, { recursive: true });
        await walk(h as FileSystemDirectoryHandle, p);
      } else {
        const file = await (h as FileSystemFileHandle).getFile();
        total += file.size;
        if (total > MAX_LOAD) throw new Error(`This folder has more than ${MAX_LOAD / 1024 ** 2} MB of files (not counting node_modules, .git and build output). Open a smaller folder.`);
        await fs.writeFile(`${ROOT}/${p}`, new Uint8Array(await file.arrayBuffer()));
      }
    }
  };
  await walk(handle, prefix);
}

async function makeWorkspace(handle: FileSystemDirectoryHandle, kind: Workspace["kind"], label: string): Promise<Workspace> {
  const fs = new InMemoryFs();
  await fs.mkdir(ROOT, { recursive: true });
  await loadInto(fs, handle);
  dirty = new Set();
  removed = new Set();
  track(fs);
  const ws: Workspace = {
    fs,
    kind,
    label,
    list: () => fs.getAllPaths().filter((p) => p.startsWith(ROOT + "/")).map(rel),
    async flush() {
      const write = [...dirty];
      const gone = [...removed];
      dirty = new Set();
      removed = new Set();
      for (const p of gone) {
        const r = rel(p);
        if (!r) continue;
        const parent = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
        try {
          await (await dirFor(handle, parent, false)).removeEntry(r.split("/").pop()!, { recursive: true });
        } catch {}
      }
      for (const p of write) {
        const r = rel(p);
        if (!r || !p.startsWith(ROOT)) continue;
        try {
          const st = await fs.stat(p);
          if (st.isDirectory) {
            await dirFor(handle, r, true);
            continue;
          }
          const parent = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
          const fh = await (await dirFor(handle, parent, true)).getFileHandle(r.split("/").pop()!, { create: true });
          const w = await fh.createWritable();
          await w.write(new Uint8Array(await fs.readFileBuffer(p)));
          await w.close();
        } catch (err) {
          console.warn("couldn't save", p, err);
        }
      }
    },
  };
  return ws;
}

export async function opfsWorkspace(): Promise<Workspace> {
  const root = await navigator.storage.getDirectory();
  return makeWorkspace(await root.getDirectoryHandle("workspace", { create: true }), "browser", "workspace in this browser");
}

/** Let the user pick a real folder (Chromium; Brave needs brave://flags/#file-system-access-api). */
export async function openFolder(): Promise<Workspace> {
  const pick = (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!pick) throw new Error("This browser can't open folders on disk (File System Access API). Chrome, Edge and Arc can; in Brave turn it on at brave://flags/#file-system-access-api. The workspace in this browser still works.");
  const handle = await pick({ mode: "readwrite", id: "lvw-workspace" });
  await db.put("kv", "folder", handle);
  return makeWorkspace(handle, "folder", `folder ${handle.name}`);
}

/** The last opened folder if permission is still granted, else the browser workspace. */
export async function restoreWorkspace(): Promise<Workspace> {
  const handle = await db.get<FileSystemDirectoryHandle>("kv", "folder").catch(() => undefined);
  if (handle) {
    try {
      const h = handle as unknown as { queryPermission(o: unknown): Promise<string> };
      if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return (current = await makeWorkspace(handle, "folder", `folder ${handle.name}`));
    } catch {}
  }
  return (current = await opfsWorkspace());
}

export async function useWorkspace(ws: Workspace) {
  current = ws;
}

export async function closeFolder() {
  await db.del("kv", "folder");
  current = await opfsWorkspace();
  return current;
}

export function workspace(): Workspace {
  if (!current) throw new Error("The workspace isn't ready yet.");
  return current;
}

/** A blob URL for previewing a workspace file in a sandboxed frame. */
export async function previewBlob(path: string): Promise<string> {
  const ws = workspace();
  const p = path.startsWith("/") ? path : `${ROOT}/${path}`;
  const bytes = await ws.fs.readFileBuffer(p);
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const type = ({ html: "text/html", htm: "text/html", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/plain", json: "application/json" } as Record<string, string>)[ext] ?? "application/octet-stream";
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
}
