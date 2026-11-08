// Create page and chat attachments against a running `lvw serve` that has speech set up.
// Run: bun test/e2e/media.e2e.ts   (LVW_URL, SHOTS and IMAGE=<png to attach> are optional)
import { chromium } from "playwright-core";

const base = process.env.LVW_URL ?? "http://127.0.0.1:7878";
const out = process.env.SHOTS ?? "/tmp";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const check = (ok: boolean, what: string) => {
  console.log(ok ? "ok  " : "FAIL", what);
  if (!ok) process.exitCode = 1;
};

await page.goto(`${base}/#create`);
await page.waitForSelector(".tabs button");
check((await page.locator(".tabs button").count()) === 6, "six kinds on the Create page");
const gallery = await page.locator(".gallery .item").count();
check(gallery > 0, `gallery shows ${gallery} results`);
if (await page.locator("model-viewer").count()) {
  await page.waitForFunction(() => Boolean(customElements.get("model-viewer")), null, { timeout: 15000 });
  await page.waitForTimeout(2500);
  check(true, "3D viewer loaded from the vendored script");
}
await page.screenshot({ path: `${out}/lvw-create.png`, fullPage: false });

// Make speech through the page and wait for the player.
await page.click(".tabs button:has-text('Speech')");
await page.fill(".create textarea[aria-label=Prompt]", "Testing the Create page.");
const before = await page.locator(".jobs .job").count();
await page.click("button:has-text('Make')");
await page.waitForFunction((n) => document.querySelectorAll(".jobs .job").length > n, before, { timeout: 10000 });
await page.waitForSelector(".jobs .job audio", { timeout: 240000 });
check(true, "speech job finished with an audio player");
await page.screenshot({ path: `${out}/lvw-create-speech.png` });

// Chat: attach a picture and see the chip.
await page.goto(`${base}/#chat`);
await page.waitForSelector("button[aria-label=Attach]");
if (process.env.IMAGE) {
  await page.setInputFiles(".composer input[type=file]", process.env.IMAGE);
  await page.waitForSelector(".chips .chip img");
  check(true, "attached picture shows as a chip");
}
check(await page.locator("button[aria-label=Record]").isVisible(), "voice-note button is there");
await page.screenshot({ path: `${out}/lvw-chat-attach.png` });

await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${base}/#create`);
await page.waitForSelector(".tabs button");
check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "no sideways scroll on a phone");
await page.screenshot({ path: `${out}/lvw-create-phone.png` });
check(errors.length === 0, `console errors: ${errors.length ? errors.join(" | ") : "none"}`);
await browser.close();
