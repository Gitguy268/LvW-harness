// Web UI walk-through against a running `lvw serve`. Run: bun test/e2e/web.e2e.ts
import { chromium } from "playwright-core";

const base = process.env.LVW_URL ?? "http://127.0.0.1:7878";
const out = process.env.SHOTS ?? "/tmp";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

for (const name of ["chat", "models", "tasks", "memory", "skills", "compare"]) {
  await page.goto(`${base}/#${name}`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/lvw-${name}.png` });
  console.log(name, "ok");
}
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${base}/#models`);
await page.waitForTimeout(800);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
await page.screenshot({ path: `${out}/lvw-models-phone.png` });
console.log("phone horizontal overflow:", overflow);
console.log("errors:", errors.length ? errors : "none");
await browser.close();
