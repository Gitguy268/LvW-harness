/**
 * Model specs, one syntax for every source:
 *   hf:owner/repo[@revision][:pattern]     Hugging Face (pattern = quant like Q4_K_M, or a glob)
 *   gh:owner/repo[@tag][:pattern]          GitHub release assets (falls back to repo files)
 *   gl:group/sub/project[@tag][:pattern]   GitLab releases (falls back to repo files)
 *   https://host/path/model.gguf           any direct URL
 *   ollama:name[:tag]                      handed to Ollama
 * A bare `owner/repo` means Hugging Face. Full https URLs of the three sites are understood too.
 */
export type Source =
  | { kind: "hf"; repo: string; revision: string; pattern?: string }
  | { kind: "gh"; repo: string; tag?: string; pattern?: string }
  | { kind: "gl"; project: string; tag?: string; pattern?: string; host: string }
  | { kind: "url"; url: string }
  | { kind: "ollama"; name: string };

const REPO_SPEC = /^(?<path>[^@:\s]+?)(?:@(?<ref>[^:\s]+))?(?::(?<pat>.+))?$/;

function splitRepoSpec(rest: string, minParts: number, label: string) {
  const m = REPO_SPEC.exec(rest);
  const path = m?.groups?.path?.replace(/\/+$/, "");
  if (!m || !path || path.split("/").filter(Boolean).length < minParts) {
    throw new Error(`Bad ${label} spec "${rest}". Expected owner/repo[@ref][:pattern].`);
  }
  return { path, ref: m.groups?.ref, pattern: m.groups?.pat };
}

export function gitlabHost() {
  return (process.env.LVW_GITLAB_URL ?? "https://gitlab.com").replace(/\/+$/, "");
}

export function parseSpec(input: string): Source {
  const spec = input.trim();
  if (spec.startsWith("ollama:")) {
    const name = spec.slice("ollama:".length);
    if (!name) throw new Error("ollama: needs a model name, e.g. ollama:llama3.2");
    return { kind: "ollama", name };
  }
  if (/^https?:\/\//.test(spec)) return fromUrl(spec);
  const prefix = /^(hf|gh|gl):/.exec(spec)?.[1];
  const rest = prefix ? spec.slice(prefix.length + 1) : spec;
  if (prefix === "gl") {
    const { path, ref, pattern } = splitRepoSpec(rest, 2, "GitLab");
    return { kind: "gl", project: path, tag: ref, pattern, host: gitlabHost() };
  }
  const { path, ref, pattern } = splitRepoSpec(rest, 2, prefix === "gh" ? "GitHub" : "Hugging Face");
  if (path.split("/").length !== 2) throw new Error(`"${path}" should be owner/repo.`);
  if (prefix === "gh") return { kind: "gh", repo: path, tag: ref, pattern };
  return { kind: "hf", repo: path, revision: ref ?? "main", pattern };
}

function fromUrl(spec: string): Source {
  const url = new URL(spec);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "huggingface.co" && parts.length >= 2 && !["api", "datasets", "spaces"].includes(parts[0])) {
    // https://huggingface.co/owner/repo[/resolve|blob/rev/file]
    if ((parts[2] === "resolve" || parts[2] === "blob") && parts.length >= 5) {
      return { kind: "hf", repo: `${parts[0]}/${parts[1]}`, revision: parts[3], pattern: parts.slice(4).join("/") };
    }
    return { kind: "hf", repo: `${parts[0]}/${parts[1]}`, revision: parts[3] && parts[2] === "tree" ? parts[3] : "main" };
  }
  if (url.hostname === "github.com" && parts.length >= 2) {
    if (parts[2] === "releases" && parts[3] === "download") return { kind: "url", url: spec };
    const tag = parts[2] === "releases" && parts[3] === "tag" ? parts[4] : undefined;
    return { kind: "gh", repo: `${parts[0]}/${parts[1]}`, tag };
  }
  const host = gitlabHost();
  if (spec.startsWith(host + "/") && parts.length >= 2 && !spec.includes("/-/releases/") && !spec.includes("/-/raw/")) {
    const dash = parts.indexOf("-");
    const project = (dash === -1 ? parts : parts.slice(0, dash)).join("/");
    return { kind: "gl", project, host };
  }
  return { kind: "url", url: spec };
}

export function specToString(s: Source): string {
  switch (s.kind) {
    case "hf":
      return `hf:${s.repo}${s.revision !== "main" ? `@${s.revision}` : ""}${s.pattern ? `:${s.pattern}` : ""}`;
    case "gh":
      return `gh:${s.repo}${s.tag ? `@${s.tag}` : ""}${s.pattern ? `:${s.pattern}` : ""}`;
    case "gl":
      return `gl:${s.project}${s.tag ? `@${s.tag}` : ""}${s.pattern ? `:${s.pattern}` : ""}`;
    case "url":
      return s.url;
    case "ollama":
      return `ollama:${s.name}`;
  }
}

/** Glob (`*`, `?`) or a plain token matched case-insensitively anywhere in the file name (a quant like Q4_K_M). */
export function matchesPattern(path: string, pattern: string): boolean {
  if (/[*?]/.test(pattern)) {
    const re = new RegExp(
      "^" + pattern.split(/(\*\*|\*|\?)/).map((t) => (t === "**" ? ".*" : t === "*" ? "[^/]*" : t === "?" ? "[^/]" : t.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("") + "$",
      "i",
    );
    return re.test(path) || re.test(path.split("/").pop()!);
  }
  if (path === pattern) return true;
  const name = path.split("/").pop()!.toLowerCase();
  const p = pattern.toLowerCase();
  // Quant names must match as a whole token: q4_k matches Q4_K but not Q4_K_M.
  return new RegExp(`(^|[-._/])${p.replace(/[.+^${}()|[\]\\]/g, "\\$&")}([-.]|$)`).test(name) || path.toLowerCase() === p;
}
