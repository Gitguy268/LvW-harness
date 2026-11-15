/** SKILL.md front matter. Browser-safe. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      // A YAML block scalar (">", "|-"…) starts empty; its indented lines follow.
      out[key] = /^[>|][-+]?$/.test(kv[2].trim()) ? "" : kv[2].replace(/^["']|["']$/g, "").trim();
    } else if (key && /^\s+/.test(line)) out[key] = `${out[key]} ${line.trim()}`.trim();
  }
  return out;
}
