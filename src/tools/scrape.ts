import { Type } from "@earendil-works/pi-ai";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../paths.ts";
import { defineTool, type LvwTool, type ToolContext } from "./tool.ts";

/**
 * D4Vinci/Scrapling (BSD-3-Clause) as an optional sidecar for sites that block plain fetches.
 * Installed on demand with uv into ~/.lvw/tools, never bundled.
 */
const toolsDir = () => join(paths().home, "tools");
export const scraplingBin = () => join(toolsDir(), "bin", "scrapling");

function uvEnv() {
  return { ...process.env, UV_TOOL_DIR: join(toolsDir(), "uv"), UV_TOOL_BIN_DIR: join(toolsDir(), "bin") };
}

async function sh(argv: string[], env = uvEnv()) {
  const proc = Bun.spawn(argv, { env, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed`);
}

/** `browsers` also downloads Scrapling's stealth browser (several hundred MB). */
export async function installScrapling(opts: { browsers?: boolean } = {}) {
  const uv = Bun.which("uv");
  if (!uv) throw new Error("Scrapling is installed with uv. Install it first: https://docs.astral.sh/uv/");
  await sh([uv, "tool", "install", "--force", "scrapling[fetchers,rag]"]);
  if (opts.browsers) await sh([scraplingBin(), "install"]);
  return scraplingBin();
}

export async function removeScrapling() {
  const uv = Bun.which("uv");
  if (uv && existsSync(scraplingBin())) await sh([uv, "tool", "uninstall", "scrapling"]);
}

export function scrapeTools(_ctx: ToolContext): LvwTool[] {
  if (!existsSync(scraplingBin())) return [];
  return [
    defineTool({
      name: "web_scrape",
      label: "Scrape",
      description:
        "Fetch a page that web_fetch couldn't read (blocked, bot checks), as Markdown of its main content. stealth=true uses a real headless browser and can pass Cloudflare checks; selector keeps only matching elements.",
      risk: "read",
      parameters: Type.Object({
        url: Type.String(),
        selector: Type.Optional(Type.String({ description: "CSS selector" })),
        stealth: Type.Optional(Type.Boolean()),
      }),
      async execute({ url, selector, stealth }, signal) {
        const dir = mkdtempSync(join(tmpdir(), "lvw-scrape-"));
        const out = join(dir, "page.md");
        const argv = stealth
          ? [scraplingBin(), "extract", "fetch", url, out, "--solve-cloudflare", "--network-idle"]
          : [scraplingBin(), "extract", "get", url, out, "--ai-targeted"];
        if (selector) argv.push("-s", selector);
        try {
          const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: uvEnv() });
          signal?.addEventListener("abort", () => proc.kill());
          const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
          if (code !== 0 || !existsSync(out)) throw new Error(stderr.trim().split("\n").slice(-3).join("\n") || `scrapling exited with ${code}`);
          const md = readFileSync(out, "utf8");
          return md.length > 20_000 ? `${md.slice(0, 20_000)}\n… [cut]` : md || "(empty page)";
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    }),
  ];
}
