// Packs ./skills into src/skills/bundled.json so the compiled binary carries them.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "skills");
const out: Record<string, Record<string, string>> = {};

function walk(dir: string, files: Record<string, string>, base: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files, base);
    else files[relative(base, p)] = readFileSync(p, "utf8");
  }
}

for (const skill of readdirSync(root).sort()) {
  const dir = join(root, skill);
  if (!statSync(dir).isDirectory()) continue;
  out[skill] = {};
  walk(dir, out[skill], dir);
}

writeFileSync(join(import.meta.dir, "..", "src", "skills", "bundled.json"), JSON.stringify(out));
console.log(`bundled ${Object.keys(out).length} skills`);
