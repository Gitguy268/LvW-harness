import { Type } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getToken } from "../credentials.ts";
import { findSdServer } from "../media/sdcpp.ts";
import { sidecarInstalled } from "../media/sidecar.ts";
import { listInstalledMedia, type MediaOutput } from "../media/store.ts";
import { make, mediaStatus, type MakeRequest } from "../media/make.ts";
import { defineTool, type LvwTool, type ToolContext } from "./tool.ts";

/** What the model reads back, plus `details.media` so the web UI can show the file inline. */
function result(out: MediaOutput) {
  const lines = [`Saved ${out.kind} to ${out.path}`];
  if (out.text !== undefined) lines.unshift(out.text || "(no speech found)");
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { media: { kind: out.kind, rel: out.rel, mime: out.mime, path: out.path, text: out.text } } };
}

function readFile(ctx: ToolContext, p: string) {
  const full = isAbsolute(p) ? p : resolve(ctx.cwd, p);
  if (!existsSync(full)) throw new Error(`No file ${p}`);
  return new Uint8Array(readFileSync(full));
}

const num = Type.Optional(Type.Number());

/**
 * Media tools, added only for kinds that are set up (locally or through an API key),
 * so small models don't see tools they can't use.
 */
export async function mediaTools(ctx: ToolContext): Promise<LvwTool[]> {
  const api = ctx.config.media.api;
  const openai = Boolean(getToken("openai") || api.openai?.baseUrl);
  const replicate = Boolean(getToken("replicate"));
  const sd = Boolean(findSdServer());
  const installed = listInstalledMedia();
  const has = (kind: string) => installed.some((m) => m.entry.kinds.includes(kind as never));
  let audio: string[] = [];
  try {
    audio = (await mediaStatus()).filter((r) => r.engine === "ollama" && r.ready).flatMap((r) => r.kinds);
  } catch {}
  const ready = {
    image: (sd && has("image")) || (openai && api.openai?.image) || (replicate && api.replicate?.image),
    video: (sd && has("video")) || (replicate && api.replicate?.video),
    speech: audio.includes("speech") || (openai && api.openai?.speech),
    transcribe: audio.includes("transcribe") || (openai && api.openai?.transcribe),
    music: sidecarInstalled("music") || (replicate && api.replicate?.music),
    "3d": sidecarInstalled("3d") || (replicate && api.replicate?.["3d"]),
  };
  const run = (req: MakeRequest, signal?: AbortSignal) => make(req, { signal }).then(result);
  const tools: LvwTool[] = [];
  if (ready.image)
    tools.push(
      defineTool({
        name: "generate_image",
        label: "Image",
        description: "Draw a picture from a detailed prompt (subject, style, lighting, framing). With image_path it edits or restyles that picture instead.",
        risk: "write",
        parameters: Type.Object({ prompt: Type.String(), image_path: Type.Optional(Type.String()), width: num, height: num, seed: num }),
        execute: ({ prompt, image_path, width, height, seed }, signal) => run({ kind: "image", prompt, image: image_path ? readFile(ctx, image_path) : undefined, width, height, seed }, signal),
      }),
    );
  if (ready.video)
    tools.push(
      defineTool({
        name: "generate_video",
        label: "Video",
        description: "Make a short silent clip (a few seconds) from a prompt describing motion. image_path animates that picture. Slow: minutes without a GPU.",
        risk: "write",
        parameters: Type.Object({ prompt: Type.String(), image_path: Type.Optional(Type.String()), frames: num, seed: num }),
        execute: ({ prompt, image_path, frames, seed }, signal) => run({ kind: "video", prompt, image: image_path ? readFile(ctx, image_path) : undefined, frames, seed }, signal),
      }),
    );
  if (ready.speech)
    tools.push(
      defineTool({
        name: "speak",
        label: "Speak",
        description: "Read text aloud into a WAV file (text to speech).",
        risk: "write",
        parameters: Type.Object({ text: Type.String(), voice: Type.Optional(Type.String()) }),
        execute: ({ text, voice }, signal) => run({ kind: "speech", prompt: text, voice }, signal),
      }),
    );
  if (ready.transcribe)
    tools.push(
      defineTool({
        name: "transcribe",
        label: "Transcribe",
        description: "Turn speech in an audio file into text. translate=true gives English.",
        risk: "read",
        parameters: Type.Object({ path: Type.String(), language: Type.Optional(Type.String()), translate: Type.Optional(Type.Boolean()) }),
        execute: ({ path, language, translate }, signal) => run({ kind: "transcribe", audio: readFile(ctx, path), language, translate }, signal),
      }),
    );
  if (ready.music)
    tools.push(
      defineTool({
        name: "generate_music",
        label: "Music",
        description: "Compose music or a sound bed. prompt = genre, instruments, mood, tempo; lyrics with [verse]/[chorus] tags for a song, none for instrumental.",
        risk: "write",
        parameters: Type.Object({ prompt: Type.String(), lyrics: Type.Optional(Type.String()), seconds: num, seed: num }),
        execute: ({ prompt, lyrics, seconds, seed }, signal) => run({ kind: "music", prompt, lyrics, seconds, seed }, signal),
      }),
    );
  if (ready["3d"])
    tools.push(
      defineTool({
        name: "generate_3d",
        label: "3D",
        description: "Make a 3D model (GLB) of one object, from a picture (image_path) or from a text prompt (a picture is drawn first).",
        risk: "write",
        parameters: Type.Object({ prompt: Type.Optional(Type.String()), image_path: Type.Optional(Type.String()), seed: num }),
        execute: ({ prompt, image_path, seed }, signal) => run({ kind: "3d", prompt, image: image_path ? readFile(ctx, image_path) : undefined, seed }, signal),
      }),
    );
  return tools;
}
