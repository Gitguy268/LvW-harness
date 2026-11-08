import { createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadConfig } from "../config.ts";
import { findModel } from "../models/registry.ts";
import { serverState, startServer } from "../runtime/llamacpp.ts";
import { ollamaOpenAiUrl } from "../runtime/ollama.ts";

// Local servers ignore the key, but the OpenAI client needs one.
const keyless = { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "local" } }) } };
// llama.cpp and Ollama speak OpenAI chat completions, minus a few newer fields.
const LOCAL_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: "max_tokens" as const };

/** What a local model takes besides text. Audio rides in image blocks and is rewritten by `audioPayload`. */
export interface Senses {
  sees: boolean;
  hears: boolean;
}

/** Ask Ollama (/api/show capabilities) or llama-server (/props modalities) what the model takes. */
export async function localSenses(kind: "ollama" | "llama", id: string, baseUrl: string): Promise<Senses> {
  try {
    if (kind === "ollama") {
      const root = baseUrl.replace(/\/v1$/, "");
      const res = await fetch(`${root}/api/show`, { method: "POST", body: JSON.stringify({ model: id }), signal: AbortSignal.timeout(3000) });
      const caps = ((await res.json()) as { capabilities?: string[] }).capabilities ?? [];
      return { sees: caps.includes("vision"), hears: caps.includes("audio") };
    }
    const res = await fetch(baseUrl.replace(/\/v1$/, "/props"), { signal: AbortSignal.timeout(3000) });
    const m = ((await res.json()) as { modalities?: { vision?: boolean; audio?: boolean } }).modalities ?? {};
    return { sees: Boolean(m.vision), hears: Boolean(m.audio) };
  } catch {
    return { sees: false, hears: false };
  }
}

/**
 * pi-ai sends every image block as image_url. Audio we attached as an image block with an
 * audio/* type becomes the input_audio part that llama.cpp and Ollama read.
 */
export function audioPayload(payload: unknown): unknown {
  const p = payload as { messages?: { content?: unknown }[] };
  if (!Array.isArray(p?.messages)) return payload;
  for (const msg of p.messages) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.map((part: { type?: string; image_url?: { url?: string } }) => {
      const m = part?.type === "image_url" ? /^data:audio\/([\w.+-]+);base64,(.*)$/s.exec(part.image_url?.url ?? "") : null;
      if (!m) return part;
      const format = m[1] === "mpeg" ? "mp3" : m[1].replace(/^x-/, "");
      return { type: "input_audio", input_audio: { data: m[2], format } };
    });
  }
  return payload;
}

function localModel(provider: string, id: string, baseUrl: string, ctx: number, senses: Senses = { sees: false, hears: false }): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: senses.sees || senses.hears ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctx,
    maxTokens: Math.min(8192, Math.floor(ctx / 2)),
    compat: LOCAL_COMPAT,
  };
}

export interface ResolvedChatModel {
  models: MutableModels;
  model: Model<any>;
  /** Human label, e.g. "Qwen3-4B (llama.cpp)". */
  label: string;
  local: boolean;
  senses?: Senses;
}

/**
 * Turn a model reference into a ready model. Local GGUF models start llama-server on demand.
 * Accepts a registry name, "local" (whatever llama-server runs), "ollama:<name>" or "<provider>:<model-id>".
 */
export async function resolveChatModel(ref = loadConfig().model, onStatus?: (s: string) => void): Promise<ResolvedChatModel> {
  const models = builtinModels();
  if (!ref) {
    const running = serverState();
    if (!running) throw new Error("No model chosen. Run `lvw setup`, or `lvw model use <name>` after pulling one.");
    ref = "local";
  }
  if (ref.startsWith("ollama:")) {
    const id = ref.slice(7);
    const senses = await localSenses("ollama", id, ollamaOpenAiUrl());
    const model = localModel("ollama", id, ollamaOpenAiUrl(), loadConfig().ollamaCtx, senses);
    models.setProvider(createProvider({ id: "ollama", auth: keyless, models: [model], api: openAICompletionsApi() }));
    return { models, model, label: `${id} (Ollama)`, local: true, senses };
  }
  const record = ref === "local" ? undefined : findModel(ref);
  if (ref === "local" || record) {
    const state = record ? await startServer(record, { onStatus }) : serverState();
    if (!state) throw new Error("llama-server isn't running. Start one with `lvw model run <name>`.");
    const base = `http://127.0.0.1:${state.port}/v1`;
    const senses = await localSenses("llama", state.modelName, base);
    const model = localModel("lvw-local", state.modelName, base, state.ctx, senses);
    models.setProvider(createProvider({ id: "lvw-local", auth: keyless, models: [model], api: openAICompletionsApi() }));
    return { models, model, label: `${state.modelName} (llama.cpp)`, local: true, senses };
  }
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const model = models.getModel(ref.slice(0, colon), ref.slice(colon + 1));
    if (model) return { models, model, label: `${model.name} (${model.provider})`, local: false, senses: { sees: model.input.includes("image"), hears: false } };
  }
  throw new Error(`Unknown model "${ref}". Use a name from \`lvw model ls\`, ollama:<name>, or <provider>:<model-id> (e.g. anthropic:claude-sonnet-5-5 with ANTHROPIC_API_KEY set).`);
}
