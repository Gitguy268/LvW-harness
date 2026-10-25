/**
 * Compile `lvw` into single-file binaries in dist/.
 *   bun scripts/build.ts          this machine only (dist/lvw)
 *   bun scripts/build.ts --all    macOS arm64, Linux x64 and Linux arm64 (dist/lvw-<os>-<arch>)
 * chromium-bidi stays external: Playwright only loads it for Firefox/BiDi, and LvW drives Chromium over CDP.
 */
import { $ } from "bun";

const TARGETS = ["bun-darwin-arm64", "bun-linux-x64", "bun-linux-arm64"];
const all = process.argv.includes("--all");
const external = ["--external", "chromium-bidi", "--external", "chromium-bidi/*"];

for (const target of all ? TARGETS : [undefined]) {
  const out = target ? `dist/lvw-${target.replace("bun-", "")}` : "dist/lvw";
  await $`bun build src/cli/main.ts --compile --minify ${target ? ["--target", target] : []} ${external} --outfile ${out}`;
}
