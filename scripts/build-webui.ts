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
  metafile: true,
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
// Cross-origin isolation (for wllama's threads) only when the page runs the harness itself.
// Connected to a desktop harness, nothing runs here, and isolation would block that harness's
// pictures, audio and preview frames (they carry no CORP header), so the service worker goes.
const head = `    <script>
      (function () {
        var remote = false;
        try { remote = !!localStorage.getItem("lvw.remote") || /[#&]connect=/.test(location.hash); } catch (e) {}
        window.coi = { quiet: true, shouldRegister: function () { return !remote; } };
        if (remote && navigator.serviceWorker) {
          navigator.serviceWorker.getRegistrations().then(function (rs) {
            if (!rs.length) return;
            Promise.all(rs.map(function (r) { return r.unregister(); })).then(function () { if (window.crossOriginIsolated) location.reload(); });
          });
        }
      })();
    </script>
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

// 6. Licences of everything that ships in the page: every npm package the bundler pulled in
//    (from its metafile), just-bash's own dependencies (its browser build has them inlined),
//    and the files copied above. Copyleft or unknown licences stop the build.
const COPYLEFT = /\b(A?GPL|LGPL|MPL|EUPL|CDDL|EPL|OSL|SSPL)\b/i;
const bundled = new Set<string>();
for (const input of Object.keys((result as unknown as { metafile: { inputs: Record<string, unknown> } }).metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
  if (m) bundled.add(m[1]);
}
const pkgDir = (name: string): string | undefined =>
  // A copy nested under the package that uses it is the one that was bundled.
  [nm(`just-bash/node_modules/${name}`), nm(`@earendil-works/pi-ai/node_modules/${name}`), nm(`@earendil-works/pi-agent-core/node_modules/${name}`), nm(name)].find((d) => existsSync(join(d, "package.json")));
const jb = JSON.parse(readFileSync(nm("just-bash/package.json"), "utf8")) as { dependencies?: Record<string, string> };
for (const d of Object.keys(jb.dependencies ?? {})) bundled.add(d);
for (const extra of ["@wllama/wllama", "coi-serviceworker"]) bundled.add(extra);
const notices = [`LvW web UI ${pkg.version}: MIT, Lucas Van De Weerd.\nThird-party code in this folder, with each licence and notice as published:\n`];
const problems: string[] = [];
for (const name of [...bundled].sort()) {
  const dir = pkgDir(name);
  if (!dir) {
    problems.push(`${name}: not found in node_modules`);
    continue;
  }
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string | { type?: string }; repository?: string | { url?: string } };
  const licence = typeof meta.license === "string" ? meta.license : meta.license?.type;
  if (!licence) problems.push(`${name}: no licence field`);
  else if (COPYLEFT.test(licence)) problems.push(`${name}: ${licence} is copyleft`);
  const files = (await Array.fromAsync(new Bun.Glob("{LICEN[CS]E,LICEN[CS]E.*,COPYING,COPYING.*,NOTICE,NOTICE.*}").scan({ cwd: dir, onlyFiles: true }))).sort();
  const repo = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  notices.push(`== ${name} ${meta.version} (${licence ?? "unknown"})${repo ? ` ${repo.replace(/^git\+/, "")}` : ""}`);
  if (!files.length) notices.push(`(The package ships no licence file; its package.json says ${licence}.)`);
  for (const f of files) notices.push(readFileSync(join(dir, f), "utf8").trim());
  notices.push("");
}
notices.push(`== whisper.cpp v1.9.5 (MIT), built from source by scripts/build-whisper-wasm.sh\n${readFileSync(join(root, "src/webui/vendor/whisper/LICENSE-whisper.cpp"), "utf8").trim()}\n`);
notices.push(`== @google/model-viewer 4.4.0 (Apache-2.0, includes three.js and fflate, MIT)\n${readFileSync(join(root, "src/web/vendor/model-viewer.LICENSE"), "utf8").trim()}\n`);
if (problems.length) fail(`licence check failed:\n  ${problems.join("\n  ")}`);
writeFileSync(join(out, "THIRD-PARTY-NOTICES.txt"), notices.join("\n"));
console.log(`  ${bundled.size} bundled packages, licences checked (THIRD-PARTY-NOTICES.txt)`);

const size = (p: string) => (existsSync(p) ? Bun.file(p).size : 0);
console.log(`web UI built in ${out}`);
console.log(`  backend.js ${(size(join(out, "backend.js")) / 1024).toFixed(0)} KB, wllama.wasm ${(size(join(out, "vendor/wllama/wllama.wasm")) / 1024 ** 2).toFixed(1)} MB, whisper ${(size(join(out, "vendor/whisper/lvw-whisper.wasm")) / 1024 ** 2).toFixed(1)} MB`);
void dirname;
