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

function localModel(provider: string, id: string, baseUrl: string, ctx: number): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
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
    const model = localModel("ollama", id, ollamaOpenAiUrl(), 32768);
    models.setProvider(createProvider({ id: "ollama", auth: keyless, models: [model], api: openAICompletionsApi() }));
    return { models, model, label: `${id} (Ollama)`, local: true };
  }
  const record = ref === "local" ? undefined : findModel(ref);
  if (ref === "local" || record) {
    const state = record ? await startServer(record, { onStatus }) : serverState();
    if (!state) throw new Error("llama-server isn't running. Start one with `lvw model run <name>`.");
    const model = localModel("lvw-local", state.modelName, `http://127.0.0.1:${state.port}/v1`, state.ctx);
    models.setProvider(createProvider({ id: "lvw-local", auth: keyless, models: [model], api: openAICompletionsApi() }));
    return { models, model, label: `${state.modelName} (llama.cpp)`, local: true };
  }
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const model = models.getModel(ref.slice(0, colon), ref.slice(colon + 1));
    if (model) return { models, model, label: `${model.name} (${model.provider})`, local: false };
  }
  throw new Error(`Unknown model "${ref}". Use a name from \`lvw model ls\`, ollama:<name>, or <provider>:<model-id> (e.g. anthropic:claude-sonnet-5-5 with ANTHROPIC_API_KEY set).`);
}
