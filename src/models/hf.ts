import { getToken } from "../credentials.ts";
import { selectFiles } from "./select.ts";
import type { RemoteFile, ResolvedModel } from "./types.ts";

export const hfEndpoint = () => (process.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/+$/, "");

function authHeaders(): Record<string, string> {
  const token = getToken("hf");
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function hfFetch(url: string, repo: string) {
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Hugging Face refused access to ${repo} (${res.status}). If the model is gated, accept its terms at ${hfEndpoint()}/${repo} and run \`lvw login hf\`.`,
    );
  }
  if (res.status === 404) throw new Error(`Hugging Face has no model "${repo}" (or the revision doesn't exist).`);
  if (!res.ok) throw new Error(`Hugging Face API error ${res.status} for ${repo}`);
  return res;
}

interface TreeEntry {
  type: "file" | "directory";
  path: string;
  size: number;
  oid: string;
  lfs?: { oid: string; size: number };
}

export async function listHfFiles(repo: string, revision: string): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  let url: string | undefined = `${hfEndpoint()}/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`;
  while (url) {
    const res = await hfFetch(url, repo);
    for (const e of (await res.json()) as TreeEntry[]) {
      if (e.type !== "file") continue;
      files.push({
        path: e.path,
        url: `${hfEndpoint()}/${repo}/resolve/${encodeURIComponent(revision)}/${e.path.split("/").map(encodeURIComponent).join("/")}`,
        size: e.lfs?.size ?? e.size,
        sha256: e.lfs?.oid,
        headers: authHeaders(),
      });
    }
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
  }
  return files;
}

export async function resolveHf(repo: string, revision: string, opts: { pattern?: string; all?: boolean }): Promise<ResolvedModel> {
  const available = await listHfFiles(repo, revision);
  if (!available.length) throw new Error(`${repo} has no files.`);
  const { files, note } = selectFiles(available, opts);
  const single = files.length === 1 ? files[0].path.split("/").pop()!.replace(/\.gguf$/i, "") : undefined;
  return { dir: `hf/${repo}`, available, selected: files, name: single ?? repo.split("/")[1], note };
}

export interface HfSearchResult {
  id: string;
  downloads: number;
  likes: number;
  gguf: boolean;
  gated: boolean;
}

export async function searchHf(query: string, limit = 20): Promise<HfSearchResult[]> {
  const url = `${hfEndpoint()}/api/models?search=${encodeURIComponent(query)}&sort=downloads&limit=${limit}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Hugging Face search failed (${res.status})`);
  const rows = (await res.json()) as { id: string; downloads?: number; likes?: number; tags?: string[]; gated?: unknown }[];
  return rows.map((r) => ({
    id: r.id,
    downloads: r.downloads ?? 0,
    likes: r.likes ?? 0,
    gguf: (r.tags ?? []).includes("gguf"),
    gated: Boolean(r.gated),
  }));
}
