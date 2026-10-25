// Interactive flows against a running `lvw serve`: pull + remove a model with the buttons, and a chat with an approval.
// Run: LVW_CHAT_MODEL=ollama:gemma4:e4b bun test/e2e/flows.e2e.ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.LVW_URL ?? "http://127.0.0.1:7878";
const out = process.env.SHOTS ?? "/tmp";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on("dialog", (d) => d.accept());
const step = (s: string) => console.log("·", s);

// Models: choose a quant, download it, remove it.
await page.goto(`${base}/#models`);
await page.getByLabel("Model source").fill("hf:unsloth/SmolLM2-135M-Instruct-GGUF");
await page.getByRole("button", { name: "Choose files…" }).first().click();
await page.locator(".choice", { hasText: "Q2_K" }).click();
await page.screenshot({ path: `${out}/lvw-flow-choose.png` });
await page.getByRole("button", { name: "Download", exact: true }).click();
step("download started");
const row = page.locator("tr", { hasText: "SmolLM2-135M-Instruct-Q2_K" });
await row.waitFor({ timeout: 120_000 });
step("model listed");
await page.screenshot({ path: `${out}/lvw-flow-pulled.png` });
await row.getByRole("button", { name: "Remove" }).click();
await row.waitFor({ state: "detached", timeout: 30_000 });
step("model removed");

// Chat: ask mode, approve the write, check the file.
const cwd = mkdtempSync(join(tmpdir(), "lvw-web-"));
await page.goto(`${base}/#chat`);
await page.getByLabel("Message").waitFor();
await page.getByLabel("Model", { exact: true }).selectOption(process.env.LVW_CHAT_MODEL ?? "");
await page.getByLabel("Permissions").selectOption("ask");
await page.getByLabel("Working folder").fill(cwd);
await page.getByLabel("Message").fill("Create a file notes.txt containing the single word banana. Use the write_file tool.");
await page.getByRole("button", { name: "Send" }).click();
const allow = page.getByRole("button", { name: "Allow", exact: true });
await allow.waitFor({ timeout: 180_000 });
step("approval shown");
await page.screenshot({ path: `${out}/lvw-flow-approval.png` });
await allow.click();
await page.locator(".tool.ok").first().waitFor({ timeout: 60_000 });
await page.getByRole("button", { name: "Send" }).waitFor({ state: "visible" });
await page.waitForFunction(() => !(document.querySelector(".composer button.primary") as HTMLButtonElement)?.disabled, null, { timeout: 180_000 });
await page.screenshot({ path: `${out}/lvw-flow-chat.png` });
const file = join(cwd, "notes.txt");
console.log("notes.txt:", existsSync(file) ? JSON.stringify(readFileSync(file, "utf8")) : "missing");
await browser.close();
