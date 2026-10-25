import { getToken } from "../credentials.ts";
import { selectFiles } from "./select.ts";
import type { RemoteFile, ResolvedModel } from "./types.ts";

function headers(): Record<string, string> {
  const token = getToken("gl");
  return token ? { "private-token": token } : {};
}

async function gl<T>(host: string, path: string): Promise<{ data: T; res: Response } | undefined> {
  const res = await fetch(`${host}/api/v4${path}`, { headers: headers() });
  if (res.status === 404) return undefined;
  if (res.status === 401 || res.status === 403) throw new Error(`GitLab refused access (${res.status}). For private projects run \`lvw login gl\`.`);
  if (!res.ok) throw new Error(`GitLab API error ${res.status} for ${path}`);
  return { data: (await res.json()) as T, res };
}

interface Release {
  tag_name: string;
  assets: { links: { name: string; url: string; direct_asset_url?: string }[] };
}

async function headSize(url: string, h: Record<string, string>) {
  try {
    const res = await fetch(url, { method: "HEAD", headers: h, redirect: "follow" });
    const len = Number(res.headers.get("content-length"));
    return res.ok && len > 0 ? len : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveGl(host: string, project: string, tag: string | undefined, opts: { pattern?: string; all?: boolean }): Promise<ResolvedModel> {
  const id = encodeURIComponent(project);
  const rel = tag ? await gl<Release>(host, `/projects/${id}/releases/${encodeURIComponent(tag)}`) : await gl<Release[]>(host, `/projects/${id}/releases?per_page=1`);
  const release = Array.isArray(rel?.data) ? rel.data[0] : rel?.data;
  const h = headers();
  if (release?.assets.links.length) {
    const available: RemoteFile[] = await Promise.all(
      release.assets.links.map(async (l) => {
        const url = l.direct_asset_url ?? l.url;
        return { path: l.name, url, headers: h, size: await headSize(url, h) };
      }),
    );
    const { files, note } = selectFiles(available, opts);
    return { dir: `gl/${project}/${release.tag_name}`, available, selected: files, name: `${project.split("/").pop()}-${release.tag_name}`, note };
  }
  // No release assets: use the repository files (LFS resolved by GitLab with lfs=true).
  const info = await gl<{ default_branch: string }>(host, `/projects/${id}`);
  if (!info) throw new Error(`GitLab has no project "${project}" on ${host}.`);
  const ref = tag ?? info.data.default_branch;
  const available: RemoteFile[] = [];
  for (let page = "1"; page; ) {
    const r = await gl<{ path: string; type: string }[]>(host, `/projects/${id}/repository/tree?recursive=true&per_page=100&ref=${encodeURIComponent(ref)}&page=${page}`);
    if (!r) throw new Error(`GitLab project ${project} has no ref "${ref}".`);
    for (const e of r.data) {
      if (e.type !== "blob") continue;
      available.push({
        path: e.path,
        url: `${host}/api/v4/projects/${id}/repository/files/${encodeURIComponent(e.path)}/raw?ref=${encodeURIComponent(ref)}&lfs=true`,
        headers: h,
      });
    }
    page = r.res.headers.get("x-next-page") ?? "";
  }
  const { files, note } = selectFiles(available, opts);
  return {
    dir: `gl/${project}/${ref}`,
    available,
    selected: files,
    name: project.split("/").pop()!,
    note: `${release ? `Release ${release.tag_name} has no assets` : "No release found"}: using repository files.${note ? " " + note : ""}`,
  };
}
