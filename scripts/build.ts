/**
 * Compile `lvw` into single-file binaries in dist/.
 *   bun scripts/build.ts          this machine only (dist/lvw)
 *   bun scripts/build.ts --all    macOS arm64, Linux x64 and Linux arm64 (dist/lvw-<os>-<arch>)
 * chromium-bidi stays external: Playwright only loads it for Firefox/BiDi, and LvW drives Chromium over CDP.
 */
import type { BunPlugin, Build } from "bun";

const TARGETS = ["bun-darwin-arm64", "bun-linux-x64", "bun-linux-arm64"] as Build.CompileTarget[];
const all = process.argv.includes("--all");

// Playwright requires these through computed paths, which the compiler leaves pointing at the build
// machine's node_modules. Static requires get them embedded in the binary.
const DATA_REQUIRE = /require\(\w+\.default\.join\(packageRoot, "(package\.json|browsers\.json)"\)\)/g;
const embedPlaywrightData: BunPlugin = {
  name: "embed-playwright-data",
  setup(build) {
    build.onLoad({ filter: /playwright-core\/lib\/coreBundle\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const contents = source.replace(DATA_REQUIRE, 'require("../$1")');
      if (contents === source) throw new Error("Playwright's data requires changed: update DATA_REQUIRE in scripts/build.ts");
      return { contents, loader: "js" };
    });
  },
};

for (const target of all ? TARGETS : [undefined]) {
  const outfile = target ? `dist/lvw-${target.replace("bun-", "")}` : "dist/lvw";
  const result = await Bun.build({
    entrypoints: ["src/cli/main.ts"],
    compile: target ? { target, outfile } : { outfile },
    minify: true,
    external: ["chromium-bidi", "chromium-bidi/*"],
    plugins: [embedPlaywrightData],
  });
  if (!result.success) throw new AggregateError(result.logs, `build failed for ${outfile}`);
  console.log(`built ${outfile}`);
}
