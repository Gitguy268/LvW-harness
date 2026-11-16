import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getToken } from "../credentials.ts";
import { downloadFile } from "../models/download.ts";

interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string | null;
}

/** Search a folder tree for a file by name. */
export function findFile(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    }
  }
}

async function unpack(archive: string, dest: string) {
  const argv = archive.endsWith(".zip") ? ["unzip", "-q", "-o", archive, "-d", dest] : ["tar", "-xzf", archive, "-C", dest];
  const r = Bun.spawnSync(argv);
  if (r.exitCode !== 0) throw new Error(`Couldn't unpack ${archive}: ${r.stderr.toString().slice(0, 300)}`);
}

/**
 * Download one pinned GitHub release asset, check the sha256 GitHub publishes for it, and
 * unpack it into `<root>/<tag>`. Older tags in `root` are removed. Returns the unpacked folder.
 */
export async function installRelease(opts: {
  repo: string;
  tag: string;
  pattern: RegExp;
  root: string;
  /** Executables to mark runnable, by file name. */
  executables?: string[];
  onProgress?: (done: number, total?: number) => void;
}): Promise<string> {
  const token = getToken("gh");
  const res = await fetch(`https://api.github.com/repos/${opts.repo}/releases/tags/${opts.tag}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${opts.repo} ${opts.tag}.`);
  const assets = ((await res.json()) as { assets: GhAsset[] }).assets;
  const asset = assets.find((a) => opts.pattern.test(a.name));
  if (!asset) throw new Error(`${opts.repo} ${opts.tag} has no download for this machine (looked for ${opts.pattern}).`);
  const sha256 = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined;
  if (!sha256) throw new Error(`GitHub gave no checksum for ${asset.name}; refusing to install it.`);
  mkdirSync(opts.root, { recursive: true });
  const dest = join(opts.root, opts.tag);
  const archive = join(opts.root, asset.name);
  await downloadFile({ path: asset.name, url: asset.browser_download_url, size: asset.size, sha256 }, archive, { onProgress: opts.onProgress });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  try {
    await unpack(archive, dest);
  } finally {
    rmSync(archive, { force: true });
  }
  for (const name of opts.executables ?? []) {
    const p = findFile(dest, name);
    if (p) chmodSync(p, 0o755);
  }
  for (const old of readdirSync(opts.root)) if (old !== opts.tag) rmSync(join(opts.root, old), { recursive: true, force: true });
  return dest;
}
