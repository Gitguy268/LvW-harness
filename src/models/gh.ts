import { getToken } from "../credentials.ts";
import { selectFiles } from "./select.ts";
import type { RemoteFile, ResolvedModel } from "./types.ts";

const API = () => (process.env.LVW_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken("gh");
  return { accept: "application/vnd.github+json", "user-agent": "lvw-harness", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
}

async function gh<T>(path: string): Promise<T | undefined> {
  const res = await fetch(`${API()}${path}`, { headers: headers() });
  if (res.status === 404) return undefined;
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("GitHub API rate limit reached (60 requests/hour without a token). Run `lvw login gh` or set GITHUB_TOKEN.");
  }
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${path}`);
  return (await res.json()) as T;
}

interface Release {
  tag_name: string;
  assets: { name: string; size: number; url: string; browser_download_url: string; digest?: string | null }[];
}

export async function resolveGh(repo: string, tag: string | undefined, opts: { pattern?: string; all?: boolean }): Promise<ResolvedModel> {
  const release = await gh<Release>(tag ? `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}` : `/repos/${repo}/releases/latest`);
  if (release?.assets.length) {
    const private_ = Boolean(getToken("gh"));
    const available: RemoteFile[] = release.assets.map((a) => ({
      path: a.name,
      // With a token, the API URL also works for private repos.
      url: private_ ? a.url : a.browser_download_url,
      headers: private_ ? headers({ accept: "application/octet-stream" }) : { "user-agent": "lvw-harness" },
      size: a.size,
      sha256: a.digest?.startsWith("sha256:") ? a.digest.slice(7) : undefined,
    }));
    const { files, note } = selectFiles(available, opts);
    return { dir: `gh/${repo}/${release.tag_name}`, available, selected: files, name: `${repo.split("/")[1]}-${release.tag_name}`, note };
  }
  return resolveGhTree(repo, tag ?? "HEAD", opts, release ? `Release ${release.tag_name} has no assets` : "No release found");
}

async function resolveGhTree(repo: string, ref: string, opts: { pattern?: string; all?: boolean }, why: string): Promise<ResolvedModel> {
  const tree = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!tree) throw new Error(`GitHub has no repo or ref "${repo}@${ref}".`);
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const auth = headers({ accept: "*/*" });
  const available: RemoteFile[] = tree.tree
    .filter((e) => e.type === "blob")
    .map((e) => ({
      path: e.path,
      url: `https://raw.githubusercontent.com/${repo}/${ref}/${enc(e.path)}`,
      lfsUrl: `https://media.githubusercontent.com/media/${repo}/${ref}/${enc(e.path)}`,
      headers: auth,
    }));
  const { files, note } = selectFiles(available, opts);
  const name = repo.split("/")[1];
  return { dir: `gh/${repo}/${ref === "HEAD" ? "main" : ref}`, available, selected: files, name, note: `${why}: using repository files.${note ? " " + note : ""}` };
}
