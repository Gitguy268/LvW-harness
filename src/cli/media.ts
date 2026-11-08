import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "../config.ts";
import { MEDIA_KINDS, defaultEntry, type MediaKind } from "../media/catalog.ts";
import { make, mediaStatus, pullMedia, removeMedia, type MakeRequest } from "../media/make.ts";
import { findSdServer, installSd, removeSd, sdState, stopSd } from "../media/sdcpp.ts";
import { sidecarState, stopSidecar } from "../media/sidecar.ts";
import { listOutputs } from "../media/store.ts";
import { paths } from "../paths.ts";
import { c, fail, progressBar, table } from "./ui.ts";

export const MEDIA_HELP = `lvw media <command>

  ls                          what LvW can make and what is set up
  install <kind|sd>           set up a kind with its default model: image, video, speech,
                              transcribe, listen, 3d, music (sd = just the sd-server engine)
  pull <id>                   download one catalog model
  rm <id>                     remove a model
  use <kind> <id>             make <id> the default for <kind>
  out [n]                     the newest things LvW made
  stop                        stop the image/video, 3D and music engines

lvw make <image|video|speech|music|3d> "<prompt>" [--image file] [--model id] [-o file]
         [--width n --height n --steps n --seed n --frames n --voice v --seconds n --lyrics file]
lvw transcribe <audio-file> [--language xx] [--translate]`;

const OPTIONS = {
  image: { type: "string" },
  model: { type: "string" },
  out: { type: "string", short: "o" },
  width: { type: "string" },
  height: { type: "string" },
  steps: { type: "string" },
  seed: { type: "string" },
  frames: { type: "string" },
  voice: { type: "string" },
  seconds: { type: "string" },
  lyrics: { type: "string" },
  negative: { type: "string" },
  language: { type: "string" },
  translate: { type: "boolean" },
  variant: { type: "string" },
  json: { type: "boolean" },
} as const;

const num = (v?: string) => (v === undefined ? undefined : Number(v));

function pullProgress() {
  const bar = progressBar();
  return {
    onEvent: (e: { type: string; text?: string; file?: string; done?: number; total?: number }) => {
      if (e.type === "progress") bar.update(e.file!, e.done!, e.total!);
      else {
        bar.end();
        console.log(c.dim(e.text!));
      }
    },
    end: () => bar.end(),
  };
}

async function install(what: string, variant?: string) {
  if (what === "sd" || what === "image" || what === "video") {
    if (!findSdServer()) {
      console.log("Installing stable-diffusion.cpp…");
      const bar = progressBar();
      const r = await installSd({ variant, onProgress: (d, t) => bar.update("sd-server", d, t ?? 0) });
      bar.end();
      console.log(`${c.green("installed")} ${r.server}`);
    }
    if (what === "sd") return;
  }
  const entry = defaultEntry(what as MediaKind);
  if (!entry) fail(`Unknown kind "${what}". Kinds: ${MEDIA_KINDS.join(", ")}, or sd.`);
  console.log(`Getting ${entry.name} (${entry.sizeGB} GB, ${entry.licence})…`);
  const p = pullProgress();
  await pullMedia(entry.id, p);
  p.end();
  console.log(`${c.green("ready")} ${entry.id}`);
}

export async function mediaCommand(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  switch (cmd) {
    case "ls":
    case undefined: {
      const rows = await mediaStatus();
      if (values.json) return console.log(JSON.stringify(rows, null, 2));
      table(
        rows.map((r) => [r.ready ? c.green("●") : c.dim("○"), r.id, r.kinds.join(","), `${r.sizeGB} GB`, r.licence, r.default ? c.dim("default") : ""]),
        ["", "id", "kinds", "size", "licence", ""],
      );
      console.log(c.dim(`\nsd-server: ${findSdServer() ?? "not installed"}  ·  outputs: ${paths().media}`));
      return;
    }
    case "install":
      if (!positionals[0]) fail("lvw media install <kind|sd>");
      for (const what of positionals) await install(what, values.variant);
      return;
    case "pull": {
      if (!positionals[0]) fail("lvw media pull <id>");
      const p = pullProgress();
      if (!findSdServer() && (await mediaStatus()).find((r) => r.id === positionals[0])?.engine === "sdcpp") await install("sd", values.variant);
      await pullMedia(positionals[0], p);
      p.end();
      return console.log(`${c.green("ready")} ${positionals[0]}`);
    }
    case "rm":
      if (!positionals[0]) fail("lvw media rm <id> | lvw media rm sd");
      if (positionals[0] === "sd") {
        await stopSd();
        removeSd();
        return console.log("removed sd-server");
      }
      return console.log((await removeMedia(positionals[0])) ? `removed ${positionals[0]}` : `${positionals[0]} wasn't installed`);
    case "use": {
      const [kind, id] = positionals;
      if (!kind || !id || !MEDIA_KINDS.includes(kind as MediaKind)) fail("lvw media use <kind> <id>");
      const cfg = loadConfig();
      cfg.media.defaults[kind as MediaKind] = id;
      saveConfig(cfg);
      return console.log(`${kind} now uses ${id}`);
    }
    case "out":
      for (const o of listOutputs(Number(positionals[0] ?? 10))) console.log(`${c.dim(o.kind.padEnd(10))} ${o.path}${o.text ? c.dim(`  “${o.text.slice(0, 60)}”`) : ""}`);
      return;
    case "stop": {
      const stopped = [(await stopSd()) && "sd-server", (await stopSidecar("3d")) && "3D", (await stopSidecar("music")) && "music"].filter(Boolean);
      return console.log(stopped.length ? `stopped ${stopped.join(", ")}` : "nothing was running");
    }
    case "status":
      return console.log(JSON.stringify({ sd: sdState(), "3d": sidecarState("3d"), music: sidecarState("music") }, null, 2));
    default:
      console.log(MEDIA_HELP);
      if (cmd !== "help") process.exitCode = 1;
  }
}

function readInput(p: string) {
  const full = resolve(p);
  if (!existsSync(full)) fail(`No file ${p}`);
  return new Uint8Array(readFileSync(full));
}

async function runMake(req: MakeRequest, out?: string, json?: boolean) {
  const ctrl = new AbortController();
  process.on("SIGINT", () => ctrl.abort());
  let lastLine = "";
  const result = await make(req, {
    signal: ctrl.signal,
    onProgress: (p) => {
      const line = p.total ? `${p.status} ${p.step}/${p.total}` : p.status;
      if (line === lastLine) return;
      lastLine = line;
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${c.dim(line)}`);
    },
  });
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  if (out) copyFileSync(result.path, resolve(out));
  if (json) return console.log(JSON.stringify({ ...result, path: out ? resolve(out) : result.path }));
  if (result.text !== undefined) console.log(result.text);
  console.log(c.dim(out ? resolve(out) : result.path));
}

export async function makeCommand(argv: string[]) {
  const [kind, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  if (!kind || !["image", "video", "speech", "music", "3d"].includes(kind)) fail('lvw make <image|video|speech|music|3d> "<prompt>" (see lvw media help)');
  await runMake(
    {
      kind: kind as MakeRequest["kind"],
      prompt: positionals.join(" ") || undefined,
      image: values.image ? readInput(values.image) : undefined,
      model: values.model,
      negative: values.negative,
      width: num(values.width),
      height: num(values.height),
      steps: num(values.steps),
      seed: num(values.seed),
      frames: num(values.frames),
      voice: values.voice,
      seconds: num(values.seconds),
      lyrics: values.lyrics ? readFileSync(resolve(values.lyrics), "utf8") : undefined,
    },
    values.out,
    values.json,
  );
}

export async function transcribeCommand(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  if (!positionals[0]) fail("lvw transcribe <audio-file> [--language xx] [--translate]");
  await runMake({ kind: "transcribe", audio: readInput(positionals[0]), model: values.model, language: values.language, translate: values.translate }, values.out, values.json);
}
