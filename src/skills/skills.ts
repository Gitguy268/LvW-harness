import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { getToken } from "../credentials.ts";
import { gitlabHost } from "../models/source.ts";
import { paths } from "../paths.ts";
import { pluginSkillDirs } from "../plugins/plugins.ts";
import bundled from "./bundled.json" with { type: "json" };

/**
 * Agent Skills (SKILL.md with name/description frontmatter). Only names and descriptions go into
 * the prompt; the agent loads a skill's full text with load_skill when it needs it.
 */
export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
  scope: "user" | "project" | "draft";
}

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

const draftsDir = () => join(paths().skills, "_drafts");

function scan(dir: string, scope: Skill["scope"]): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => {
      const file = join(dir, e.name, "SKILL.md");
      const fm = parseFrontmatter(readFileSync(file, "utf8"));
      return { name: fm.name || e.name, description: fm.description ?? "", dir: join(dir, e.name), file, scope };
    });
}

/** Project skills override user skills with the same name. */
export function listSkills(cwd: string, includeDrafts = false): Skill[] {
  const byName = new Map<string, Skill>();
  const fromPlugins = pluginSkillDirs().flatMap((d) => scan(d, "user"));
  for (const s of [...fromPlugins, ...scan(paths().skills, "user"), ...scan(join(cwd, ".lvw", "skills"), "project")]) byName.set(s.name, s);
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return includeDrafts ? [...list, ...scan(draftsDir(), "draft")] : list;
}

export function getSkill(name: string, cwd: string, includeDrafts = false) {
  return listSkills(cwd, includeDrafts).find((s) => s.name === name);
}

export function skillIndex(cwd: string, descriptionChars = 300): string {
  const skills = listSkills(cwd);
  if (!skills.length) return "";
  // Skills meant only for an explicit request cost a name, not a description, in every prompt.
  const onRequest = skills.filter((s) => /^use only when the user explicitly/i.test(s.description));
  const listed = skills.filter((s) => !onRequest.includes(s)).map((s) => `- ${s.name}: ${s.description.slice(0, descriptionChars)}`);
  if (onRequest.length) listed.push(`Only when the user asks for one by name: ${onRequest.map((s) => s.name).join(", ")}`);
  return listed.join("\n");
}

/** Copy the skills shipped inside the binary into ~/.lvw/skills, without touching ones already there. */
export function installBundledSkills(): number {
  let n = 0;
  for (const [name, filesMap] of Object.entries(bundled as Record<string, Record<string, string>>)) {
    const dir = join(paths().skills, name);
    if (existsSync(dir)) continue;
    for (const [rel, content] of Object.entries(filesMap)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
      if (content.startsWith("#!")) chmodSync(join(dir, rel), 0o755);
    }
    n++;
  }
  return n;
}

export function removeSkill(name: string, cwd: string) {
  const s = getSkill(name, cwd, true);
  if (!s) throw new Error(`No skill "${name}".`);
  rmSync(s.dir, { recursive: true, force: true });
  return s;
}

/** Save a skill the agent wrote as a draft; it only becomes active once you approve it (hermes-agent's learning loop). */
export function proposeSkill(name: string, description: string, body: string) {
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  const dir = join(draftsDir(), safe);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${safe}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body.trim()}\n`);
  return dir;
}

export function approveSkill(name: string) {
  const from = join(draftsDir(), name);
  if (!existsSync(join(from, "SKILL.md"))) throw new Error(`No draft skill "${name}".`);
  const to = join(paths().skills, name);
  if (existsSync(to)) rmSync(to, { recursive: true });
  renameSync(from, to);
  return to;
}

function findSkillDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    if (existsSync(join(d, "SKILL.md"))) return void out.push(d);
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(join(d, e.name), depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Markdown agent definitions in an `agents` folder next to a plugin's skills. */
function findAgentFiles(base: string): string[] {
  const dir = join(base, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
}

function licenceOf(dir: string, repoRoot: string) {
  for (const d of [dir, repoRoot]) {
    const f = existsSync(d) ? readdirSync(d).find((x) => /^(licen[cs]e|copying)(\.|$)/i.test(x)) : undefined;
    if (f) return { file: join(d, f), first: readFileSync(join(d, f), "utf8").split("\n").find((l) => l.trim())?.trim() ?? "?" };
  }
  return undefined;
}

/**
 * Install skills from gh:owner/repo[/sub/path][@ref], gl:group/project[/-/sub/path][@ref], or a local folder.
 * Every installed skill keeps the repo's licence file next to it.
 */
export async function addSkills(spec: string, opts: { project?: string } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "lvw-skill-"));
  try {
    let root: string;
    let sub = "";
    if (existsSync(spec)) {
      root = spec;
    } else {
      const m = /^(gh|gl):([^@]+?)(?:@(.+))?$/.exec(spec);
      if (!m) throw new Error("Use gh:owner/repo[/path][@ref], gl:group/project[/-/path][@ref] or a local folder.");
      const [, host, path, ref] = m;
      let url: string;
      const headers: Record<string, string> = {};
      if (host === "gh") {
        const [owner, repo, ...rest] = path.split("/");
        sub = rest.join("/");
        url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref ?? "HEAD"}`;
        const t = getToken("gh");
        if (t) headers.authorization = `Bearer ${t}`;
      } else {
        const [project, rest = ""] = path.split("/-/");
        sub = rest;
        url = `${gitlabHost()}/api/v4/projects/${encodeURIComponent(project)}/repository/archive.tar.gz${ref ? `?sha=${encodeURIComponent(ref)}` : ""}`;
        const t = getToken("gl");
        if (t) headers["private-token"] = t;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Couldn't download ${spec} (HTTP ${res.status}).`);
      const archive = join(tmp, "src.tar.gz");
      await Bun.write(archive, res);
      mkdirSync(join(tmp, "src"));
      const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", join(tmp, "src"), "--strip-components=1"]);
      if (tar.exitCode !== 0) throw new Error(`Couldn't unpack ${spec}.`);
      root = join(tmp, "src");
    }
    const base = sub ? join(root, sub) : root;
    if (!existsSync(base)) throw new Error(`${spec} has no folder "${sub}".`);
    const dirs = findSkillDirs(base);
    const agentFiles = opts.project ? [] : findAgentFiles(base);
    if (!dirs.length && !agentFiles.length) throw new Error(`No SKILL.md found in ${spec}.`);
    const target = opts.project ? join(opts.project, ".lvw", "skills") : paths().skills;
    mkdirSync(target, { recursive: true });
    const installed: { name: string; licence: string }[] = [];
    for (const d of dirs) {
      const fm = parseFrontmatter(readFileSync(join(d, "SKILL.md"), "utf8"));
      const name = (fm.name || basename(d)).replace(/[^\w.-]+/g, "-");
      const dest = join(target, name);
      rmSync(dest, { recursive: true, force: true });
      cpSync(d, dest, { recursive: true });
      const lic = licenceOf(d, root);
      if (lic && !existsSync(join(dest, basename(lic.file)))) cpSync(lic.file, join(dest, "LICENSE"));
      installed.push({ name, licence: lic?.first ?? "no licence file found (all rights reserved: use with care)" });
    }
    const agents: string[] = [];
    for (const file of agentFiles) {
      agents.push(basename(file, ".md"));
      cpSync(file, join(paths().agents, basename(file)));
    }
    return { installed, agents, from: relative(root, base) || "." };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface NamedAgent {
  name: string;
  description: string;
  prompt: string;
}

/** Named subagents: Markdown files in ~/.lvw/agents, or .lvw/agents in the project, which win. */
export function listAgents(cwd: string): NamedAgent[] {
  const byName = new Map<string, NamedAgent>();
  for (const dir of [paths().agents, join(cwd, ".lvw", "agents")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      const text = readFileSync(join(dir, f), "utf8");
      const fm = parseFrontmatter(text);
      const name = fm.name || basename(f, ".md");
      byName.set(name, { name, description: fm.description ?? "", prompt: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim() });
    }
  }
  return [...byName.values()];
}

/** Plugins in a skills marketplace (wshobson/agents and others that use its format). */
export async function browseMarketplace(repo: string): Promise<{ name: string; description: string; source: string }[]> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/marketplace.json`);
  if (!res.ok) throw new Error(`${repo} has no plugin list (HTTP ${res.status}).`);
  const data = (await res.json()) as { plugins?: { name: string; description?: string; source?: unknown }[] };
  return (data.plugins ?? [])
    .filter((p) => typeof p.source === "string" && p.source.startsWith("./"))
    .map((p) => ({ name: p.name, description: p.description ?? "", source: (p.source as string).slice(2) }));
}
