import { Type } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { defineTool, type LvwTool, type ToolContext } from "./tool.ts";

/**
 * Browser tools. Ideas from ego-lite (each agent gets its own isolated "Space" and a compact page
 * snapshot with element refs; multi-step work goes in one script), browser-use (act on refs, not
 * pixels) and Tencent's BrowserSkill (attach to your real, logged-in browser over CDP).
 */
let browser: Promise<Browser> | undefined;
const spaces = new Map<string, { context: BrowserContext; page: Page; own: boolean }>();

const SYSTEM_BROWSERS = [
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

async function getBrowser(ctx: ToolContext): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const cfg = ctx.config.browser;
  if (cfg.cdpUrl) return (browser ??= chromium.connectOverCDP(cfg.cdpUrl));
  browser ??= (async () => {
    try {
      return await chromium.launch({ headless: cfg.headless, executablePath: cfg.executablePath });
    } catch (err) {
      // No Playwright Chromium downloaded: fall back to a browser that's already installed.
      const fallback = SYSTEM_BROWSERS.find((p) => existsSync(p));
      if (!fallback || cfg.executablePath) throw new Error(`Couldn't start a browser: ${(err as Error).message.split("\n")[0]}. Run \`bunx playwright-core install chromium\` or set browser.executablePath.`);
      return chromium.launch({ headless: cfg.headless, executablePath: fallback });
    }
  })();
  return browser;
}

async function space(ctx: ToolContext) {
  let s = spaces.get(ctx.sessionId);
  if (s && !s.page.isClosed()) return s;
  const b = await getBrowser(ctx);
  // Over CDP, reuse the real profile's context so logins carry over, but in a new tab.
  const shared = ctx.config.browser.cdpUrl ? b.contexts()[0] : undefined;
  const context = shared ?? (await b.newContext({ viewport: { width: 1280, height: 900 } }));
  const page = await context.newPage();
  s = { context, page, own: !shared };
  spaces.set(ctx.sessionId, s);
  return s;
}

/** Runs in the page: tag interactive elements with refs and describe them in a few lines each. */
const SNAPSHOT = () => {
  const sel = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=true], [onclick]';
  const lines: string[] = [];
  let n = 0;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  for (const el of Array.from(document.querySelectorAll(sel))) {
    if (!visible(el)) continue;
    const ref = `e${++n}`;
    el.setAttribute("data-lvw-ref", ref);
    const tag = el.tagName.toLowerCase();
    const label = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 80);
    let desc = `[${ref}] ${el.getAttribute("role") || tag}`;
    if (tag === "input") desc += `[type=${(el as HTMLInputElement).type}]`;
    if (label) desc += ` "${label}"`;
    if (tag === "a") desc += ` → ${(el.getAttribute("href") || "").slice(0, 80)}`;
    if ("value" in el && (el as HTMLInputElement).value && (el as HTMLInputElement).type !== "password") desc += ` value="${String((el as HTMLInputElement).value).slice(0, 60)}"`;
    if ((el as HTMLInputElement).checked) desc += " (checked)";
    lines.push(desc);
    if (n >= 250) break;
  }
  const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 4000);
  return `Title: ${document.title}\nURL: ${location.href}\n\nInteractive elements:\n${lines.join("\n") || "(none)"}\n\nPage text:\n${text}`;
};

async function snapshot(page: Page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return page.evaluate(SNAPSHOT);
}

const byRef = (page: Page, ref: string) => page.locator(`[data-lvw-ref="${ref.replace(/[^\w-]/g, "")}"]`).first();

export function browserTools(ctx: ToolContext): LvwTool[] {
  return [
    defineTool({
      name: "browser_open",
      label: "Open page",
      description: "Open a URL in your own browser tab and return a snapshot: page text plus interactive elements with refs like [e5].",
      risk: "read",
      parameters: Type.Object({ url: Type.String() }),
      async execute({ url }) {
        const { page } = await space(ctx);
        await page.goto(url.includes("://") ? url : `https://${url}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        return snapshot(page);
      },
    }),
    defineTool({
      name: "browser_snapshot",
      label: "Look at page",
      description: "Snapshot the current page again (after it changed).",
      risk: "read",
      parameters: Type.Object({}),
      async execute() {
        return snapshot((await space(ctx)).page);
      },
    }),
    defineTool({
      name: "browser_click",
      label: "Click",
      description: "Click an element by its ref from the last snapshot. Returns a new snapshot.",
      risk: "external",
      parameters: Type.Object({ ref: Type.String({ description: "e.g. e12" }) }),
      async execute({ ref }) {
        const { page } = await space(ctx);
        await byRef(page, ref).click({ timeout: 10_000 });
        await page.waitForTimeout(500);
        return snapshot(page);
      },
    }),
    defineTool({
      name: "browser_type",
      label: "Type",
      description: "Fill a text field by ref. Set submit to press Enter afterwards.",
      risk: "external",
      parameters: Type.Object({ ref: Type.String(), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
      async execute({ ref, text, submit }) {
        const { page } = await space(ctx);
        const el = byRef(page, ref);
        await el.fill(text, { timeout: 10_000 });
        if (submit) await el.press("Enter");
        await page.waitForTimeout(500);
        return snapshot(page);
      },
    }),
    defineTool({
      name: "browser_script",
      label: "Page script",
      description:
        "Run JavaScript inside the current page for multi-step work in one go (read many values, fill a form, collect a table). The body of an async function; `ref('e5')` returns an element by snapshot ref. Return a JSON-serialisable value.",
      risk: "external",
      parameters: Type.Object({ code: Type.String() }),
      async execute({ code }) {
        const { page } = await space(ctx);
        const result = await page.evaluate(async (src) => {
          const ref = (r: string) => document.querySelector(`[data-lvw-ref="${r}"]`);
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const fn = new Function("ref", `return (async () => { ${src} })()`);
          return await fn(ref);
        }, code);
        return typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "undefined";
      },
    }),
    defineTool({
      name: "browser_screenshot",
      label: "Screenshot",
      description: "Take a screenshot of the current page (for models that can see images).",
      risk: "read",
      parameters: Type.Object({ full_page: Type.Optional(Type.Boolean()) }),
      async execute({ full_page }) {
        const { page } = await space(ctx);
        const png = await page.screenshot({ fullPage: full_page ?? false, type: "png" });
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], details: undefined };
      },
    }),
  ];
}

/** Close one session's tab; the browser itself stays up for the others. */
export async function closeSpace(sessionId: string) {
  const s = spaces.get(sessionId);
  if (!s) return;
  spaces.delete(sessionId);
  await s.page.close().catch(() => {});
  // Never close the user's own profile when attached over CDP.
  if (s.own) await s.context.close().catch(() => {});
}

export async function closeBrowser() {
  for (const s of spaces.values()) await s.page.close().catch(() => {});
  spaces.clear();
  if (browser) await (await browser).close().catch(() => {});
  browser = undefined;
}
