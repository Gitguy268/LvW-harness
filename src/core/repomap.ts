/**
 * A condensed map of a repository's files and top-level symbols, ranked by how often other
 * files mention them (after Aider's repo map, without tree-sitter: regexes per language).
 * Browser-safe: callers hand in the file texts.
 */

export interface SourceFile {
  path: string;
  text: string;
}

const LANGS: { ext: RegExp; patterns: RegExp[] }[] = [
  {
    ext: /\.(m|c)?[jt]sx?$/,
    patterns: [
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
      /^class\s+([A-Za-z_$][\w$]*)/gm,
    ],
  },
  { ext: /\.py$/, patterns: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm] },
  { ext: /\.go$/, patterns: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm] },
  { ext: /\.rs$/, patterns: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|mod|const)\s+([A-Za-z_]\w*)/gm, /^(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm] },
  { ext: /\.(java|kt|cs|swift)$/, patterns: [/^\s*(?:public|internal|open|export)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|struct|protocol|object|record|fun|func)\s+([A-Za-z_]\w*)/gm] },
  { ext: /\.(c|h|cc|cpp|hpp)$/, patterns: [/^(?:static\s+)?(?:inline\s+)?[A-Za-z_][\w:<>*&\s]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm, /^(?:struct|class|enum)\s+([A-Za-z_]\w*)/gm] },
  { ext: /\.(rb)$/, patterns: [/^\s*(?:def|class|module)\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/gm] },
  { ext: /\.(php)$/, patterns: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|function)\s+([A-Za-z_]\w*)/gm] },
];

/** Folders and files a map never needs. */
export const MAP_SKIP = /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|\.venv|venv|__pycache__|\.next|coverage|\.cache)(\/|$)|\.min\.js$|\.lock$|lock\.json$/;

export function symbolsOf(file: SourceFile): string[] {
  const lang = LANGS.find((l) => l.ext.test(file.path));
  if (!lang) return [];
  const found = new Set<string>();
  for (const re of lang.patterns) for (const m of file.text.matchAll(re)) if (m[1] && m[1].length > 1) found.add(m[1]);
  return [...found];
}

export function isMappable(path: string) {
  return !MAP_SKIP.test(path) && LANGS.some((l) => l.ext.test(path));
}

/**
 * Build the map within `budgetChars`. Files whose symbols other files mention most come first;
 * each file lists its most-referenced symbols.
 */
export function buildRepoMap(files: SourceFile[], budgetChars = 6000): string {
  const mapped = files.filter((f) => isMappable(f.path)).map((f) => ({ ...f, symbols: symbolsOf(f) }));
  if (!mapped.length) return "";
  // Count mentions of each symbol in other files, word-bounded.
  const owner = new Map<string, string>();
  for (const f of mapped) for (const s of f.symbols) if (!owner.has(s)) owner.set(s, f.path);
  const refs = new Map<string, number>();
  const word = /[A-Za-z_$][\w$]*/g;
  for (const f of mapped) {
    const seen = new Set<string>();
    for (const m of f.text.matchAll(word)) {
      const w = m[0];
      const o = owner.get(w);
      if (o && o !== f.path && !seen.has(w)) {
        seen.add(w);
        refs.set(w, (refs.get(w) ?? 0) + 1);
      }
    }
  }
  const ranked = mapped
    .map((f) => ({ path: f.path, score: f.symbols.reduce((n, s) => n + (refs.get(s) ?? 0), 0), symbols: [...f.symbols].sort((a, b) => (refs.get(b) ?? 0) - (refs.get(a) ?? 0)) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const lines: string[] = [];
  let used = 0;
  for (const f of ranked) {
    const shown = f.symbols.slice(0, 12);
    const line = shown.length ? `${f.path}: ${shown.join(", ")}${f.symbols.length > shown.length ? `, +${f.symbols.length - shown.length}` : ""}` : f.path;
    if (used + line.length + 1 > budgetChars) {
      lines.push(`… ${ranked.length - lines.length} more files`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** A budget from the model's context window: about 4% of it, none for very small windows. */
export function repoMapBudget(contextWindow: number): number {
  if (contextWindow < 12_000) return 0;
  return Math.min(12_000, Math.floor(contextWindow * 4 * 0.04));
}
