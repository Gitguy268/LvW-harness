/**
 * Chat models in the browser.
 *
 * Local GGUF models run in wllama (llama.cpp compiled to WebAssembly, WebGPU when the browser has
 * it). wllama speaks the OpenAI chat format, so it sits behind a fake endpoint (net.ts LOCAL_BASE)
 * and the harness uses its normal OpenAI-compatible provider, exactly like llama-server natively.
 * Hosted models (OpenAI, Anthropic, Google, OpenRouter…) go through pi-ai with keys from Settings;
 * Ollama works when it allows this page's origin (OLLAMA_ORIGINS).
 */
import { createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadWllama, Wllama } from "../vendor-wllama.ts";
import { isProjector } from "../../models/select.ts";
import { getSettings } from "./db.ts";
import { findModel, isWhisper, openModel } from "./models.ts";
import { LOCAL_BASE, setLocalHandler } from "./net.ts";

const keyless = { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "local" } }) } };
const LOCAL_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: "max_tokens" as const };
const WASM = new URL("./vendor/wllama/wllama.wasm", document.baseURI).href;

export interface Senses {
  sees: boolean;
  hears: boolean;
}

export interface ResolvedChatModel {
  models: MutableModels;
  model: Model<any>;
  label: string;
  local: boolean;
  senses?: Senses;
}

interface Instance {
  w: InstanceType<typeof Wllama>;
  name: string;
  ctx: number;
  gpu: boolean;
  lastUsed: number;
}
const instances = new Map<string, Promise<Instance>>();
/** Set after a WebGPU crash: later loads use the CPU until the page reloads. */
let gpuFailed = false;
/** A wasm abort (WebGPU queue failure, device lost, out of memory) kills the instance. */
const isCrash = (err: unknown) => /\babort|unreachable|webgpu|device (was )?lost|out of bounds|out of memory/i.test(String((err as Error)?.message ?? err));

async function crashed(name: string, err: unknown) {
  console.warn("in-browser model crashed", err);
  if (!gpuFailed) gpuFailed = true;
  await unload(name);
  status("The model crashed on the GPU; reloading it on the CPU (slower)…");
}
const MAX_LOADED = 2;
let status: (s: string) => void = () => {};
export const onModelStatus = (fn: (s: string) => void) => (status = fn);

export function loadedModels() {
  return [...instances.keys()];
}

async function load(name: string): Promise<Instance> {
  const existing = instances.get(name);
  if (existing) return existing;
  // Keep at most two models in memory (chat + vision); drop the least recently used.
  if (instances.size >= MAX_LOADED) {
    const all = await Promise.all([...instances.values()].map((p) => p.catch(() => undefined)));
    const oldest = all.filter(Boolean).sort((a, b) => a!.lastUsed - b!.lastUsed)[0];
    if (oldest) await unload(oldest.name);
  }
  const p = (async () => {
    const m = await findModel(name);
    if (!m) throw new Error(`No downloaded model "${name}". Get one on the Models page.`);
    const settings = await getSettings();
    status(`Loading ${m.name}…`);
    const files = await openModel(m);
    await loadWllama();
    const w = new Wllama({ default: WASM }, { suppressNativeLog: true, allowOffline: true });
    const gpu = settings.gpu && !gpuFailed && "gpu" in navigator;
    await w.loadModel(files, { n_ctx: settings.ctx, n_gpu_layers: gpu ? undefined : 0 });
    status("");
    return { w, name: m.name, ctx: settings.ctx, gpu, lastUsed: Date.now() };
  })();
  instances.set(name, p);
  p.catch(() => instances.delete(name));
  return p;
}

export async function unload(name?: string) {
  for (const [n, p] of [...instances.entries()]) {
    if (name && n !== name) continue;
    instances.delete(n);
    try {
      await (await p).w.exit();
    } catch {}
  }
}

const dataUrlBytes = (url: string) => {
  const b64 = url.slice(url.indexOf(",") + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
};

/** OpenAI-format messages (what pi-ai sends) → wllama's format (binary images and audio). */
function toWllama(messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[]) {
  return messages.map((m) => {
    const role = m.role === "developer" ? "system" : m.role;
    if (!Array.isArray(m.content)) return { ...m, role, content: m.content ?? "" };
    if (role !== "user") return { ...m, role, content: m.content.map((p: { text?: string }) => p.text ?? "").join("") };
    return {
      role,
      content: m.content.map((p: { type: string; text?: string; image_url?: { url: string }; input_audio?: { data: string } }) => {
        if (p.type === "image_url" && p.image_url?.url.startsWith("data:")) return { type: "image", data: dataUrlBytes(p.image_url.url) };
        if (p.type === "input_audio" && p.input_audio) return { type: "audio", data: dataUrlBytes(`data:;base64,${p.input_audio.data}`) };
        return { type: "text", text: p.text ?? "" };
      }),
    };
  });
}

const PASS = ["temperature", "top_p", "top_k", "min_p", "stop", "seed", "tools", "tool_choice", "response_format", "presence_penalty", "frequency_penalty"];

setLocalHandler(async (url, init) => {
  if (url.endsWith("/models")) return Response.json({ object: "list", data: loadedModels().map((id) => ({ id, object: "model" })) });
  if (!url.endsWith("/chat/completions")) return new Response("Not found", { status: 404 });
  const body = JSON.parse(String(init?.body ?? "{}"));
  const name = String(body.model);
  const params: Record<string, unknown> = { messages: toWllama(body.messages ?? []), max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 2048, abortSignal: init?.signal ?? undefined };
  for (const k of PASS) if (body[k] !== undefined) params[k] = body[k];
  const run = async (stream: boolean) => {
    const inst = await load(name);
    inst.lastUsed = Date.now();
    return inst.w.createChatCompletion({ ...params, stream } as never);
  };
  if (!body.stream) {
    try {
      return Response.json(await run(false));
    } catch (err) {
      if (!isCrash(err)) throw err;
      await crashed(name, err);
      return Response.json(await run(false));
    }
  }
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(ctrl) {
        let sent = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            for await (const chunk of (await run(true)) as unknown as AsyncIterable<unknown>) {
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              sent++;
            }
            ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
            break;
          } catch (err) {
            if ((err as Error).name === "AbortError" || init?.signal?.aborted) break;
            const crash = isCrash(err);
            if (crash) await crashed(name, err);
            // Nothing reached the agent yet: try once more (on the CPU after a crash).
            if (crash && sent === 0 && attempt === 0) continue;
            const message = crash ? "The in-browser model crashed (WebGPU). It has been reloaded on the CPU; send the message again." : (err as Error).message;
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`));
            break;
          }
        }
        ctrl.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
});

function localModel(provider: string, id: string, baseUrl: string, ctx: number, sees: boolean): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: sees ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctx,
    maxTokens: Math.min(4096, Math.floor(ctx / 2)),
    compat: LOCAL_COMPAT,
  };
}

/** Same reference forms as the native harness: a downloaded model's name, ollama:<name>, or <provider>:<model-id>. */
export async function resolveChatModel(ref?: string): Promise<ResolvedChatModel> {
  const settings = await getSettings();
  ref ||= settings.model;
  const models = builtinModels();
  if (!ref) throw new Error("No model chosen. Get one on the Models page (K2-Horizon is the suggested one), or add an API key in Settings and pick a hosted model.");
  if (ref.startsWith("ollama:")) {
    const id = ref.slice(7);
    const model = localModel("ollama", id, "http://127.0.0.1:11434/v1", 32768, false);
    models.setProvider(createProvider({ id: "ollama", auth: keyless, models: [model], api: openAICompletionsApi() }));
    return { models, model, label: `${id} (Ollama)`, local: true, senses: { sees: false, hears: false } };
  }
  const record = await findModel(ref);
  if (record) {
    const sees = record.files.some((f) => isProjector(f.path));
    const model = localModel("lvw-local", record.name, LOCAL_BASE, settings.ctx, sees);
    models.setProvider(createProvider({ id: "lvw-local", auth: keyless, models: [model], api: openAICompletionsApi() }));
    return { models, model, label: `${record.name} (in this browser)`, local: true, senses: { sees, hears: false } };
  }
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const model = models.getModel(ref.slice(0, colon), ref.slice(colon + 1));
    if (model) return { models, model, label: `${model.name} (${model.provider})`, local: false, senses: { sees: model.input.includes("image"), hears: false } };
  }
  throw new Error(`Unknown model "${ref}". Use a model from the Models page, ollama:<name>, or <provider>:<model-id> with its API key set in Settings.`);
}

/** Add the vision model to a chat model's provider set, for turns that carry a picture. */
export async function attachVisionModel(resolved: ResolvedChatModel): Promise<Model<any> | undefined> {
  const ref = (await getSettings()).visionModel;
  if (!ref || resolved.senses?.sees) return undefined;
  const record = await findModel(ref);
  if (!record) throw new Error(`The vision model "${ref}" isn't downloaded. Get LFM3-VL on the Models page, or clear it in Settings.`);
  if (!record.files.some((f) => isProjector(f.path))) throw new Error(`${record.name} has no vision projector (mmproj), so it can't see pictures.`);
  const model = localModel("lvw-vision", record.name, LOCAL_BASE, (await getSettings()).ctx, true);
  resolved.models.setProvider(createProvider({ id: "lvw-vision", auth: keyless, models: [model], api: openAICompletionsApi() }));
  return model;
}
