// The static web UI end to end, in Playwright's Chromium with a real WebGPU adapter.
// Run: bun scripts/build-webui.ts && bun test/e2e/webui.e2e.ts [smoke|smol|k2|vision|whisper|all]
// Serves dist/webui under /LvW-harness/webui/ from a plain static server (no COOP/COEP headers),
// so coi-serviceworker has to make the page cross-origin isolated, as on GitHub Pages.
// PROFILE=<dir> keeps downloads between runs (default: a temp folder, deleted at the end).
import { chromium, type Page } from "playwright-core";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const which = process.argv[2] ?? "smoke";
const dist = resolve(process.env.DIST ?? resolve(import.meta.dir, "../../dist/webui"));
const PREFIX = "/LvW-harness/webui/";
const killer = setTimeout(() => (console.log("FAIL timed out"), process.exit(2)), Number(process.env.TIMEOUT_MIN ?? 25) * 60_000);

// A fixed port: the origin decides which browser storage (models, chats) the page sees.
const server = Bun.serve({
  port: Number(process.env.PORT ?? 8946),
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(PREFIX)) return new Response("not found", { status: 404 });
    let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || "index.html";
    if (rel.includes("..")) return new Response("no", { status: 400 });
    const p = join(dist, rel);
    try {
      if (statSync(p).isDirectory()) rel = join(rel, "index.html");
    } catch {
      return new Response("not found", { status: 404 });
    }
    return new Response(Bun.file(join(dist, rel)));
  },
});
const base = `http://127.0.0.1:${server.port}${PREFIX}`;
const profile = process.env.PROFILE ?? mkdtempSync(join(tmpdir(), "lvw-webui-"));
const ctx = await chromium.launchPersistentContext(profile, { headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal"], viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
let failed = 0;
const cleanups: (() => void)[] = [];
const check = (ok: boolean, what: string) => {
  console.log(ok ? "ok  " : "FAIL", what);
  if (!ok) failed++;
};
const api = (p: Page, path: string, opts?: unknown) => p.evaluate(([path, opts]) => (window as any).LVW_BACKEND.request(path, opts), [path, opts] as const);

async function open(hash = "chat") {
  await page.goto(`${base}#${hash}`);
  await page.waitForFunction(() => crossOriginIsolated === true, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForSelector("#page *", { timeout: 30_000 });
}

async function pullAndWait(spec: string) {
  const job = (await api(page, "/api/models/pull", { method: "POST", body: { spec } })) as { id: string };
  for (;;) {
    const jobs = (await api(page, "/api/jobs")) as { id: string; status: string; error?: string; done: number; total: number }[];
    const j = jobs.find((x) => x.id === job.id)!;
    if (j.status !== "running") return j;
    await page.waitForTimeout(2000);
  }
}

/** Send a chat message through the UI and wait for the turn to end. */
async function chat(text: string, opts: { approve?: boolean; mode?: string } = {}) {
  await open("chat");
  if (opts.mode) await page.selectOption("select[aria-label=Mode]", opts.mode);
  await page.selectOption("select[aria-label=Permissions]", "ask");
  await page.fill("textarea[aria-label=Message]", text);
  await page.click("button:has-text('Send')");
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    if (opts.approve !== undefined && (await page.locator(".approval button.primary").count())) await page.click(opts.approve ? ".approval button.primary" : ".approval button.danger");
    if (await page.locator("button:has-text('Send'):not([disabled])").count()) {
      await page.waitForTimeout(500);
      if (await page.locator("button:has-text('Send'):not([disabled])").count()) break;
    }
    await page.waitForTimeout(700);
  }
  return page.locator(".transcript").innerText();
}

try {
  // ---- smoke: the page, isolation, every page renders, no errors ----
  await open("chat");
  check(await page.evaluate(() => crossOriginIsolated), "cross-origin isolated through coi-serviceworker");
  check(await page.evaluate(() => (window as any).LVW_BACKEND?.kind === "browser"), "in-browser backend is active");
  for (const p of ["chat", "create", "models", "recipes", "tasks", "memory", "skills", "compare", "settings"]) {
    await open(p);
    await page.waitForTimeout(400);
    check((await page.locator("#page h1, #page .transcript").count()) > 0, `page ${p} renders`);
  }
  await open("models");
  await page.waitForSelector(".suggested .pick", { timeout: 15_000 });
  const cards = await page.locator(".suggested .pick").allInnerTexts();
  check(cards.length === 5 && cards.some((c) => c.includes("K2-Horizon")) && cards.some((c) => c.includes("Connect your LvW-harness")), "five suggested models, Yue2/Idol marked desktop-only");
  await page.screenshot({ path: join(tmpdir(), "lvw-webui-models.png") });
  const status = (await api(page, "/api/status")) as { browser: boolean; isolated: boolean };
  check(status.browser && status.isolated, "status reports browser + isolated");
  // Recipes round trip.
  await api(page, "/api/recipes", { method: "PUT", body: { text: "name: hello\nprompt: Say hello to {{who}}\nparameters:\n  - key: who\n    default: Spot\n" } });
  const rendered = (await api(page, "/api/recipes/hello/render", { method: "POST", body: {} })) as { prompt: string };
  check(rendered.prompt === "Say hello to Spot", "recipe saved and rendered in the browser");
  // The shell and files.
  const ws = (await page.evaluate(async () => {
    const b = (window as any).LVW_BACKEND;
    await b.request("/api/status");
    return true;
  })) as boolean;
  check(ws, "workspace ready");

  if (which === "smol" || which === "all") {
    const j = await pullAndWait("hf:bartowski/SmolLM2-135M-Instruct-GGUF:Q8_0");
    check(j.status === "done", `SmolLM2 downloaded into OPFS with SHA-256 check (${j.error ?? "ok"})`);
    const models = (await api(page, "/api/models")) as { name: string; runnable: boolean }[];
    const smol = models.find((m) => m.name.includes("SmolLM2"));
    check(Boolean(smol?.runnable), "SmolLM2 listed as runnable");
    await api(page, `/api/models/${encodeURIComponent(smol!.name)}/default`, { method: "POST" });
    const t = await chat("Say hello in five words.", { mode: "ask" });
    check(/\S/.test(t.split("Say hello in five words.")[1] ?? ""), "SmolLM2 answered in the chat");
    await page.screenshot({ path: join(tmpdir(), "lvw-webui-smol.png") });
    await api(page, `/api/models/${encodeURIComponent(smol!.name)}`, { method: "DELETE" });
    check(!((await api(page, "/api/models")) as { name: string }[]).some((m) => m.name === smol!.name), "SmolLM2 removed");
  }

  if (which === "upload" || which === "all") {
    const file = join(tmpdir(), "stories260K.gguf");
    await Bun.write(file, await (await fetch("https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf")).arrayBuffer());
    await open("models");
    await page.setInputFiles("input[aria-label='GGUF files from this computer']", file);
    // Poll from here: waitForFunction would take an async predicate's Promise as "true".
    for (let i = 0; i < 60 && !((await api(page, "/api/models")) as { name: string }[]).some((m) => m.name === "stories260K"); i++) await page.waitForTimeout(1000);
    const up = ((await api(page, "/api/models")) as { name: string; runnable: boolean; files: { sha256?: string }[] }[]).find((m) => m.name === "stories260K");
    if (!up) console.log("jobs:", JSON.stringify(await api(page, "/api/jobs")).slice(0, 600));
    check(Boolean(up?.runnable && up.files[0].sha256?.length === 64), "a GGUF from this computer was added, with its SHA-256");
    const ran = await api(page, "/api/models/stories260K/run", { method: "POST" }).then(() => true, (e) => String(e));
    check(ran === true, `the uploaded GGUF loads and generates (${ran})`);
    await api(page, "/api/models/stop", { method: "POST" });
    await api(page, "/api/models/stories260K", { method: "DELETE" });
    rmSync(file, { force: true });
  }

    if (which === "sources" || which === "all") {
    // Small files from each host, through the same resolvers as `lvw model pull`.
    const gh = await pullAndWait("gh:Gitguy268/LvW-harness@main:LICENSE");
    check(gh.status === "done", `GitHub repo file downloaded (${gh.error ?? "ok"})`);
    const gl = await pullAndWait("gl:inkscape/extras/extension-manager:LICENSE.txt");
    check(gl.status === "done", `GitLab repo file downloaded through /api/v4 (${gl.error ?? "ok"})`);
    const models = (await api(page, "/api/models")) as { spec: string; size: number; missing: boolean; name: string }[];
    check(models.filter((m) => /^g[hl]:/.test(m.spec)).every((m) => m.size > 1000 && !m.missing), "both stored with their real size");
    const rel = await pullAndWait("gh:0xShug0/audio.cpp@v0.9.5:audio-v0.9.5-server-config-examples.zip");
    check(rel.status === "error" && /doesn't allow web pages|CORS proxy/.test(rel.error ?? ""), `a GitHub release file explains the CORS limit (${(rel.error ?? "").slice(0, 80)})`);
    for (const m of models) await api(page, `/api/models/${encodeURIComponent(m.name)}`, { method: "DELETE" });
  }

  if (which === "k2" || which === "all") {
    const j = await pullAndWait("hf:Lucasgitguy-co/K2-Horizon-4x0.9B-MoE-heretic-GGUF:K2-Horizon-4x0.9B-MoE-heretic-Q4_K_M.gguf");
    check(j.status === "done", `K2-Horizon Q4_K_M downloaded (${j.error ?? "ok"})`);
    const k2 = ((await api(page, "/api/models")) as { name: string }[]).find((m) => m.name.includes("K2-Horizon"))!;
    await api(page, `/api/models/${encodeURIComponent(k2.name)}/default`, { method: "POST" });
    const t = await chat("Create a file called hello.txt containing the word spot. Use the write_file tool.", { approve: true, mode: "code" });
    check(/write_file/.test(t), "K2 called write_file");
    const cat = await page.evaluate(async () => (window as any).LVW_BACKEND.request("/api/checkpoints"));
    check(Array.isArray(cat) && cat.length > 0, "a checkpoint was taken before the change");
    const t2 = await chat("Run the shell command: cat hello.txt", { approve: true });
    check(/spot/i.test(t2.split("cat hello.txt").pop() ?? ""), "bash (just-bash) read the file back");
    const cps = (await api(page, "/api/checkpoints")) as { id: string; label: string }[];
    const first = cps.find((c) => c.label.startsWith("Create a file"))!;
    const r = (await api(page, "/api/checkpoints/restore", { method: "POST", body: { id: first.id } })) as { removed: number };
    check(r.removed >= 1, "undo removed hello.txt");
    await page.screenshot({ path: join(tmpdir(), "lvw-webui-k2.png") });
  }

  if (which === "vision" || which === "all") {
    // A small text-only chat model, so the picture has to go to the vision model.
    const chatJob = await pullAndWait("hf:bartowski/SmolLM2-135M-Instruct-GGUF:Q8_0");
    check(chatJob.status === "done", "SmolLM2 ready as the chat model");
    const smolName = ((await api(page, "/api/models")) as { name: string }[]).find((m) => m.name.includes("SmolLM2"))!.name;
    await api(page, `/api/models/${encodeURIComponent(smolName)}/default`, { method: "POST" });
    const j = await pullAndWait("hf:Lucasgitguy-co/lfm3-vl-2b-heretic-gguf:lfm3-vl-2b-heretic-Q4_K_M.gguf");
    check(j.status === "done", `LFM3-VL downloaded with its projector (${j.error ?? "ok"})`);
    const lfm = ((await api(page, "/api/models")) as { name: string; files: { path: string }[] }[]).find((m) => m.name.includes("lfm3-vl"))!;
    check(lfm.files.some((f) => f.path.includes("mmproj")), "projector came along");
    await api(page, "/api/settings", { method: "PUT", body: { visionModel: lfm.name } });
    await open("chat");
    await page.setInputFiles("input[type=file][accept^='image']", resolve(import.meta.dir, "fixtures/red-circle.png"));
    await page.fill("textarea[aria-label=Message]", "What is in this picture? One sentence.");
    await page.click("button:has-text('Send')");
    await page.waitForFunction(() => /circle/i.test(document.querySelector(".transcript")?.textContent ?? ""), null, { timeout: 6 * 60_000 }).catch(() => {});
    check(/circle/i.test(await page.locator(".transcript").innerText()), "the vision model described the picture");
  }

  if (which === "whisper" || which === "all") {
    const job = (await api(page, "/api/media/pull", { method: "POST", body: { id: "whisper-large-v3-turbo" } })) as { id: string };
    for (;;) {
      const j = ((await api(page, "/api/jobs")) as { id: string; status: string; error?: string }[]).find((x) => x.id === job.id)!;
      if (j.status !== "running") {
        check(j.status === "done", `Whisper q4_1 (whisper.cpp file) downloaded (${j.error ?? "ok"})`);
        break;
      }
      await page.waitForTimeout(2000);
    }
    await open("create/transcribe");
    await page.setInputFiles("input[aria-label='Input file']", resolve(import.meta.dir, "fixtures/jfk.wav"));
    await page.click("button:has-text('Make')");
    await page.waitForSelector(".jobs .job blockquote", { timeout: 8 * 60_000 }).catch(() => {});
    check(/ask not what your country/i.test(await page.locator(".jobs").innerText()), "Whisper transcribed jfk.wav in the browser");
  }

  if (which === "connect" || which === "all") {
    // A real `lvw serve --allow-web` in a temporary home that allows this test page's origin.
    const home = mkdtempSync(join(tmpdir(), "lvw-connect-"));
    const origin = `http://127.0.0.1:${server.port}`;
    await Bun.write(join(home, "config.json"), JSON.stringify({ server: { host: "127.0.0.1", port: 7979, allowOrigins: [origin] } }));
    // A picture in the harness's media folder and a page in its working folder, for the media and preview checks.
    await Bun.write(join(home, "media", "test", "pic.png"), Bun.file(resolve(import.meta.dir, "fixtures/red-circle.png")));
    await Bun.write(join(home, "work", "page.html"), "<!doctype html><title>preview ok</title><h1 id=x>preview ok</h1>");
    const proc = Bun.spawn(["bun", resolve(import.meta.dir, "../../src/cli/main.ts"), "serve", "--allow-web", "--port", "7979", "--no-scheduler", "--cwd", join(home, "work")], { env: { ...process.env, LVW_HOME: home }, stdout: "pipe", stderr: "pipe" });
    cleanups.push(() => (proc.kill(), rmSync(home, { recursive: true, force: true })));
    let printed = "";
    const reader = proc.stdout.getReader();
    while (!printed.includes("#connect=")) {
      const { value, done } = await reader.read();
      if (done) break;
      printed += new TextDecoder().decode(value);
    }
    const link = /#connect=[^\s]+/.exec(printed)?.[0];
    check(Boolean(link), "lvw serve --allow-web printed a connect link");
    await page.goto(`${base}${link}`);
    await page.waitForSelector("#page *", { timeout: 30_000 });
    await page.waitForTimeout(1500);
    check(/Connected: 127\.0\.0\.1:7979/.test(await page.locator("#status-line").innerText()), "the page talks to the harness (status line)");
    check(!(await page.evaluate(() => location.hash.includes("token="))), "the token was taken out of the address bar");
    await open("models");
    check(await page.locator("h1:has-text('Models')").count() === 1, "Models page works through the harness");
    const viaHarness = await page.evaluate(async () => (await fetch("http://127.0.0.1:7979/api/sessions")).status);
    check(viaHarness === 401, "without the token the harness refuses the page");
    await open("chat");
    await page.waitForTimeout(1000);
    const live = await page.evaluate(() => new Promise<boolean>((res) => {
      const ws = new WebSocket("ws://127.0.0.1:7979/ws?token=" + JSON.parse(localStorage.getItem("lvw.remote")!).token);
      ws.onopen = () => (ws.close(), res(true));
      ws.onerror = () => res(false);
    }));
    check(live, "live connection to the harness with the token");
    check(!(await page.evaluate(() => crossOriginIsolated)), "connected: the page is not cross-origin isolated (the service worker is gone)");
    // The same URLs the UI builds for media results and previews.
    const media = await page.evaluate(async () => {
      const remote = JSON.parse(localStorage.getItem("lvw.remote")!);
      const img = document.createElement("img");
      img.src = `${remote.url}/media/test/pic.png?token=${encodeURIComponent(remote.token)}`;
      document.body.append(img);
      await new Promise((r) => ((img.onload = r), (img.onerror = r)));
      const frame = document.createElement("iframe");
      frame.src = `${remote.url}/api/preview?path=page.html&cwd=&token=${encodeURIComponent(remote.token)}`;
      document.body.append(frame);
      const loaded = await new Promise<boolean>((r) => ((frame.onload = () => r(true)), setTimeout(() => r(false), 8000)));
      return { img: img.naturalWidth, frame: loaded };
    });
    check(media.img > 0, `a picture from the harness shows in the page (${media.img}px wide)`);
    check(media.frame, "a preview frame from the harness loads");
    await page.evaluate(() => localStorage.removeItem("lvw.remote"));
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 5).join(" | ")}` : ""}`);
} catch (err) {
  console.log("FAIL", (err as Error).message);
  failed++;
} finally {
  for (const c of cleanups) c();
  clearTimeout(killer);
  await ctx.close();
  server.stop(true);
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true });
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
}
