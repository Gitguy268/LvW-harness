#!/usr/bin/env bun
/**
 * Build the static web UI (served at gitguy268.github.io/LvW-harness/webui/).
 *   bun scripts/build-webui.ts [outDir]   (default dist/webui)
 *
 * The page is the same UI as `lvw serve` (src/web), plus an in-page harness (src/webui/backend)
 * that answers its API in the browser. Everything is relative, so the folder works under any path.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const out = resolve(process.argv[2] ?? join(root, "dist", "webui"));
const nm = (p: string) => join(root, "node_modules", p);
const fail = (msg: string): never => {
  console.error(`build-webui: ${msg}`);
  process.exit(1);
};

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "vendor", "wllama"), { recursive: true });

// 1. The in-page harness.
const result = await Bun.build({
  entrypoints: [join(root, "src/webui/backend/main.ts")],
  outdir: out,
  naming: { entry: "backend.js", chunk: "chunks/[name]-[hash].js", asset: "assets/[name]-[hash].[ext]" },
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "linked",
  define: { __LVW_VERSION__: JSON.stringify(pkg.version), "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "lvw-browser",
      setup(build) {
        // Tokens come from Settings in the browser, not ~/.lvw/credentials.json.
        // Node modules just-bash's browser bundle still imports for features that can't run here.
        build.onResolve({ filter: /^node:(zlib|module|worker_threads|async_hooks|fs|fs\/promises)$/ }, () => ({ path: join(root, "src/webui/backend/node-stub.ts") }));
        build.onResolve({ filter: /(^|\/)credentials\.ts$/ }, (args) => (args.importer.includes("/src/webui/") ? undefined : { path: join(root, "src/webui/backend/credentials.ts") }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  fail("bundling the backend failed");
}
// Nothing node-only may slip into the page.
for (const o of result.outputs) {
  if (!o.path.endsWith(".js")) continue;
  const text = await Bun.file(o.path).text();
  // Minified real imports have no space before the quote; skill files bundled as text may mention node: modules.
  const bad = /from"node:|import\("node:/.exec(text);
  if (bad) fail(`${o.path} imports a node: module (${bad[0]})`);
}

// 2. The UI itself, shared with `lvw serve`.
cpSync(join(root, "src/web/app.js"), join(out, "app.js"));
cpSync(join(root, "src/web/style.css"), join(out, "style.css"));
cpSync(join(root, "src/web/vendor"), join(out, "vendor"), { recursive: true });
let html = readFileSync(join(root, "src/web/index.html"), "utf8");
const head = `    <script>window.coi = { quiet: true };</script>
    <script src="coi-serviceworker.min.js"></script>
    <link rel="manifest" href="manifest.webmanifest" />
    <meta name="theme-color" content="#256f68" />
`;
html = html
  .replace("<title>LvW</title>", "<title>LvW web UI</title>")
  .replace(/<meta name="description" content="[^"]*" \/>/, '<meta name="description" content="LvW-harness in your browser: an agent with GGUF models running locally (WebGPU), Hugging Face, GitHub and GitLab downloads, modes, checkpoints and recipes. Or connect it to your own LvW-harness." />')
  .replace("</head>", `${head}  </head>`)
  .replace('<script type="module" src="app.js"></script>', '<script type="module" src="backend.js"></script>\n    <script type="module" src="app.js"></script>');
if (!html.includes('src="backend.js"')) fail("couldn't add backend.js to index.html");
writeFileSync(join(out, "index.html"), html);
writeFileSync(
  join(out, "manifest.webmanifest"),
  JSON.stringify({ name: "LvW web UI", short_name: "LvW", start_url: "./", display: "standalone", background_color: "#0f1514", theme_color: "#256f68", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }] }, null, 2),
);
writeFileSync(
  join(out, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#256f68"/><path d="M8 9v14h7M17 9l3.5 14L24 9" stroke="white" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`,
);

// 3. wllama with the thread-pool patch: mtmd (images, audio) starts 4 std::threads of its own,
//    and wllama's pool only has room for the ggml threads, so without spare workers it hangs.
const wllama = readFileSync(nm("@wllama/wllama/esm/index.js"), "utf8");
const POOL = "this.useMultiThread ? nbThreads : 0,";
if (wllama.split(POOL).length !== 2) fail("wllama's thread-pool line changed; check the patch in scripts/build-webui.ts");
writeFileSync(join(out, "vendor/wllama/index.js"), wllama.replace(POOL, "this.useMultiThread ? nbThreads + 4 : 0,"));
cpSync(nm("@wllama/wllama/esm/wasm/wllama.wasm"), join(out, "vendor/wllama/wllama.wasm"));
cpSync(nm("@wllama/wllama/LICENCE"), join(out, "vendor/wllama/LICENSE"));

// 4. whisper.cpp (our own build, scripts/build-whisper-wasm.sh) and its worker.
cpSync(join(root, "src/webui/vendor/whisper"), join(out, "vendor/whisper"), { recursive: true });
cpSync(join(root, "src/webui/whisper-worker.js"), join(out, "whisper-worker.js"));

// 5. Cross-origin isolation on GitHub Pages (threads need SharedArrayBuffer).
cpSync(nm("coi-serviceworker/coi-serviceworker.min.js"), join(out, "coi-serviceworker.min.js"));

// 6. Licences of what ships in the page.
const licences: [string, string][] = [
  ["wllama (MIT)", nm("@wllama/wllama/LICENCE")],
  ["just-bash (Apache-2.0)", nm("just-bash/LICENSE")],
  ["hash-wasm (MIT)", nm("hash-wasm/LICENSE")],
  ["yaml (ISC)", nm("yaml/LICENSE")],
  ["coi-serviceworker (MIT)", nm("coi-serviceworker/LICENSE")],
  ["whisper.cpp (MIT)", join(root, "src/webui/vendor/whisper/LICENSE-whisper.cpp")],
];
const notices = [`LvW web UI ${pkg.version}: MIT, Lucas Van De Weerd. Third-party code in this folder:\n`];
for (const [name, file] of licences) {
  if (!existsSync(file)) {
    // just-bash ships its licence in the repo, not the npm package; name it and link it.
    notices.push(`== ${name}\nSee https://github.com/vercel-labs/just-bash (package.json "license": "Apache-2.0").\n`);
    continue;
  }
  notices.push(`== ${name}\n${readFileSync(file, "utf8").trim()}\n`);
}
writeFileSync(join(out, "THIRD-PARTY-NOTICES.txt"), notices.join("\n"));

const size = (p: string) => (existsSync(p) ? Bun.file(p).size : 0);
console.log(`web UI built in ${out}`);
console.log(`  backend.js ${(size(join(out, "backend.js")) / 1024).toFixed(0)} KB, wllama.wasm ${(size(join(out, "vendor/wllama/wllama.wasm")) / 1024 ** 2).toFixed(1)} MB, whisper ${(size(join(out, "vendor/whisper/lvw-whisper.wasm")) / 1024 ** 2).toFixed(1)} MB`);
void dirname;
