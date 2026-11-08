import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, loadConfig } from "../src/config.ts";
import { audioPayload, type ResolvedChatModel } from "../src/core/providers.ts";
import { Session } from "../src/core/session.ts";
import { catalog, MEDIA_KINDS, parseComponent } from "../src/media/catalog.ts";
import { isWav, transcribe } from "../src/media/api.ts";
import { make, pullMedia } from "../src/media/make.ts";
import { sdAssetPattern, sdArgs, sdBody } from "../src/media/sdcpp.ts";
import { installedMedia, listOutputs, mediaFile, saveOutput } from "../src/media/store.ts";
import { createServer } from "../src/server/server.ts";
import { fixtureServer, tempHome } from "./helpers.ts";

let home: ReturnType<typeof tempHome>;
let fake: ReturnType<typeof Bun.serve>;
const calls: { path: string; body: string }[] = [];
// 44-byte WAV header plus a little silence.
const wav = (() => {
  const b = Buffer.alloc(52);
  b.write("RIFF", 0);
  b.writeUInt32LE(44, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(8, 40);
  return new Uint8Array(b);
})();

beforeAll(() => {
  home = tempHome();
  // A stand-in for an OpenAI-compatible media API (and for Ollama's /v1/audio endpoints).
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.headers.get("content-type")?.includes("json") ? await req.text() : "(form)";
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/v1/audio/speech") return new Response(wav, { headers: { "content-type": "audio/wav" } });
      if (url.pathname === "/v1/audio/transcriptions") return Response.json({ text: "hello from the fake" });
      if (url.pathname === "/v1/images/generations") return Response.json({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }] });
      return new Response("nope", { status: 404 });
    },
  });
  const cfg = loadConfig();
  cfg.ollamaUrl = "http://127.0.0.1:9"; // nothing listens: forces the API fallback
  cfg.media.api.openai = { baseUrl: `http://127.0.0.1:${fake.port}/v1`, speech: "tts-1", transcribe: "whisper-1", image: "img-1" };
  saveConfig(cfg);
});
afterAll(() => {
  fake.stop(true);
  home.cleanup();
});

describe("media catalog", () => {
  test("entries are complete and each kind has at most one default", () => {
    const seen = new Map<string, number>();
    for (const e of catalog()) {
      expect(e.kinds.length).toBeGreaterThan(0);
      for (const k of e.kinds) expect(MEDIA_KINDS).toContain(k);
      expect(["sdcpp", "ollama", "triposr", "acestep"]).toContain(e.engine);
      expect(e.licence.length).toBeGreaterThan(0);
      if (e.engine === "sdcpp") expect(Object.keys(e.components ?? {}).length).toBeGreaterThan(0);
      if (e.engine === "ollama") expect(e.ollama).toBeTruthy();
      for (const spec of Object.values(e.components ?? {})) expect(parseComponent(spec).repo).toMatch(/^[^/]+\/[^/]+$/);
      if (e.default) for (const k of e.kinds) seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [, n] of seen) expect(n).toBe(1);
  });

  test("component specs split into repo and path", () => {
    expect(parseComponent("hf:a/b/dir/file.gguf")).toEqual({ repo: "a/b", path: "dir/file.gguf" });
    expect(() => parseComponent("gh:a/b")).toThrow();
  });
});

describe("stable-diffusion.cpp", () => {
  const names = [
    "sd-master-7bcd4ce-bin-Darwin-macOS-26.7.2-arm64.zip",
    "sd-master-7bcd4ce-bin-Linux-Ubuntu-26.04-x86_64.zip",
    "sd-master-7bcd4ce-bin-Linux-Ubuntu-26.04-x86_64-vulkan.zip",
    "sd-master-7bcd4ce-bin-win-cpu-x64.zip",
    "sd-master-7bcd4ce-bin-win-cuda12-x64.zip",
    "cudart-sd-bin-win-cu12-x64.zip",
  ];
  const pick = (os: string, cpu: string, v?: string) => names.filter((n) => sdAssetPattern(os as NodeJS.Platform, cpu as NodeJS.Architecture, v).test(n));
  test("picks one asset per platform", () => {
    expect(pick("darwin", "arm64")).toEqual([names[0]]);
    expect(pick("darwin", "x64")).toEqual([names[0]]);
    expect(pick("linux", "x64")).toEqual([names[1]]);
    expect(pick("linux", "x64", "vulkan")).toEqual([names[2]]);
    expect(pick("win32", "x64")).toEqual([names[3]]);
    expect(pick("win32", "x64", "cuda12")).toEqual([names[4]]);
    expect(() => sdAssetPattern("linux", "arm64")).toThrow(/no prebuilt/);
  });

  test("builds server args and job bodies from the catalog entry", () => {
    const entry = catalog().find((e) => e.id === "wan2.1-t2v-1.3b")!;
    const args = sdArgs({ id: entry.id, entry, files: { "diffusion-model": "/m/d.gguf", vae: "/m/v.st", model: "/m/full.gguf" }, size: 0, addedAt: 0 }, 7880);
    expect(args).toContain("--diffusion-model");
    expect(args[args.indexOf("-m") + 1]).toBe("/m/full.gguf");
    expect(args).toContain("--offload-to-cpu");
    const video = sdBody("video", { prompt: "a cat", initImage: "AAAA" }, entry);
    expect(video).toMatchObject({ prompt: "a cat", video_frames: 17, fps: 16, output_format: "webm", init_image: "AAAA" });
    expect((video.sample_params as { flow_shift: number }).flow_shift).toBe(3);
    const image = sdBody("image", { prompt: "x", steps: 4, cfg: 1 }, catalog().find((e) => e.id === "sd15")!);
    expect(image).toMatchObject({ batch_count: 1, output_format: "png", width: 512 });
    expect(image.sample_params).toMatchObject({ sample_steps: 4, guidance: { txt_cfg: 1 }, sample_method: "euler_a" });
  });

  test("pulls every component, checking sizes and checksums", async () => {
    const files = { "big.gguf": new Uint8Array(4096).fill(7), "vae.st": new Uint8Array(512).fill(3) };
    const srv = fixtureServer(files);
    const tree = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname.startsWith("/api/models/me/tiny/tree/")) {
          return Response.json(Object.entries(files).map(([path, b]) => ({ type: "file", path, size: b.length, oid: "x", lfs: { oid: createHash("sha256").update(b).digest("hex"), size: b.length } })));
        }
        return Response.redirect(`${srv.url}/${u.pathname.split("/").pop()}`);
      },
    });
    process.env.HF_ENDPOINT = `http://127.0.0.1:${tree.port}`;
    writeFileSync(join(home.dir, "media-catalog.json"), JSON.stringify({ entries: [{ id: "tiny", kinds: ["image"], engine: "sdcpp", name: "Tiny", licence: "MIT", sizeGB: 0, ramGB: 0, components: { model: "hf:me/tiny/big.gguf", vae: "hf:me/tiny/vae.st" } }] }));
    try {
      await pullMedia("tiny");
      const m = installedMedia("tiny")!;
      expect(readFileSync(m.files.model).length).toBe(4096);
      expect(readFileSync(m.files.vae)[0]).toBe(3);
    } finally {
      delete process.env.HF_ENDPOINT;
      tree.stop(true);
      srv.stop();
    }
  });
});

describe("making media through the API fallback", () => {
  test("speech, transcription and images save files with their settings", async () => {
    const said = await make({ kind: "speech", prompt: "hi there" });
    expect(said.mime).toBe("audio/wav");
    expect(isWav(new Uint8Array(readFileSync(said.path)))).toBe(true);
    expect(JSON.parse(calls.find((c) => c.path === "/v1/audio/speech")!.body)).toMatchObject({ model: "tts-1", input: "hi there", response_format: "wav" });
    const heard = await make({ kind: "transcribe", audio: wav });
    expect(heard.text).toBe("hello from the fake");
    const pic = await make({ kind: "image", prompt: "a fox" });
    expect(readFileSync(pic.path, "utf8")).toBe("png-bytes");
    expect(JSON.parse(readFileSync(`${pic.path}.json`, "utf8")).prompt).toBe("a fox");
    expect(listOutputs().map((o) => o.kind)).toEqual(expect.arrayContaining(["speech", "transcribe", "image"]));
  });

  test("a kind with nothing set up explains how to set it up", async () => {
    await expect(make({ kind: "video", prompt: "waves" })).rejects.toThrow(/lvw media pull wan2.1-t2v-1.3b/);
    await expect(make({ kind: "music", prompt: "jazz" })).rejects.toThrow(/Nothing is set up to make music/);
  });

  test("media files can't escape the media folder", () => {
    const out = saveOutput("image", new Uint8Array([1]), ".png", {});
    expect(mediaFile(out.rel)).toBe(out.path);
    expect(mediaFile("../config.json")).toBeUndefined();
    expect(mediaFile("/etc/passwd")).toBeUndefined();
  });

  test("transcribe sends multipart audio", async () => {
    expect(await transcribe({ baseUrl: `http://127.0.0.1:${fake.port}/v1` }, { model: "m", audio: wav })).toBe("hello from the fake");
  });
});

describe("audio and pictures in chat", () => {
  test("audio blocks become input_audio parts; pictures stay image_url", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:audio/wav;base64,UklGRg==" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBO" } },
            { type: "image_url", image_url: { url: "data:audio/mpeg;base64,SUQz" } },
          ],
        },
      ],
    };
    const out = audioPayload(payload) as typeof payload;
    expect(out.messages[0].content[1]).toEqual({ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } } as never);
    expect(out.messages[0].content[2].type).toBe("image_url");
    expect(out.messages[0].content[3]).toEqual({ type: "input_audio", input_audio: { data: "SUQz", format: "mp3" } } as never);
  });

  function faux(senses: { sees: boolean; hears: boolean }) {
    const f = fauxProvider();
    const models = createModels();
    models.setProvider(f.provider);
    const resolved: ResolvedChatModel = { models, model: f.getModel(), label: "faux", local: true, senses };
    return { f, resolved };
  }
  const cwd = mkdtempSync(join(tmpdir(), "lvw-media-cwd-"));

  test("a model that hears gets the audio itself", async () => {
    const { f, resolved } = faux({ sees: true, hears: true });
    f.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const s = await Session.create({ cwd, resolved, permissions: "readonly", persist: false });
    await s.prompt("what is this?", [
      { mime: "audio/wav", data: Buffer.from(wav).toString("base64") },
      { mime: "image/png", data: "iVBO" },
    ]);
    const user = s.agent.state.messages.find((m) => (m as { role: string }).role === "user") as { content: { type: string; mimeType?: string }[] };
    expect(user.content.filter((b) => b.type === "image").map((b) => b.mimeType)).toEqual(["audio/wav", "image/png"]);
  });

  test("a model that doesn't hear gets a transcript", async () => {
    const { f, resolved } = faux({ sees: false, hears: false });
    f.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const s = await Session.create({ cwd, resolved, permissions: "readonly", persist: false });
    await s.prompt("", [{ mime: "audio/wav", data: Buffer.from(wav).toString("base64"), name: "note.wav" }]);
    const user = s.agent.state.messages.find((m) => (m as { role: string }).role === "user") as { content: { type: string; text?: string }[] };
    expect(user.content.map((b) => b.text ?? "").join("")).toContain("[Voice note note.wav, transcribed]: hello from the fake");
  });
});

describe("media routes", () => {
  test("serve made files with their type and refuse others", async () => {
    const srv = createServer({ host: "127.0.0.1", port: 0, cwd: home.dir });
    try {
      const out = saveOutput("3d", new Uint8Array([103, 108, 84, 70]), ".glb", { prompt: "cube" });
      const res = await fetch(`http://127.0.0.1:${srv.port}/media/${out.rel}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("model/gltf-binary");
      expect((await fetch(`http://127.0.0.1:${srv.port}/media/..%2Fconfig.json`)).status).toBe(404);
      const page = await fetch(`http://127.0.0.1:${srv.port}/`);
      expect(page.headers.get("content-security-policy")).toContain("media-src 'self'");
      const list = (await (await fetch(`http://127.0.0.1:${srv.port}/api/media`)).json()) as { catalog: unknown[]; outputs: { rel: string }[] };
      expect(list.catalog.length).toBeGreaterThan(5);
      expect(list.outputs.some((o) => o.rel === out.rel)).toBe(true);
      expect((await fetch(`http://127.0.0.1:${srv.port}/vendor/model-viewer.min.js`)).headers.get("content-type")).toContain("javascript");
      expect(existsSync(out.path)).toBe(true);
    } finally {
      srv.stop(true);
    }
  });
});
