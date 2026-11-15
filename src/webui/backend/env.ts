// Loaded first: the shared harness code reads process.env (API keys, endpoints, test knobs).
// In the browser, keys come from Settings and are kept in this browser's IndexedDB.
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined>; platform?: string; versions?: Record<string, string>; cwd?: () => string; getBuiltinModule?: () => undefined } };
g.process ??= { env: {} };
g.process.env ??= {};
g.process.platform ??= "browser";
g.process.versions ??= {};
g.process.cwd ??= () => "/workspace";
g.process.getBuiltinModule ??= () => undefined;

export const env = g.process.env;

/** Settings keys that become environment variables for pi-ai and the model sources. */
export const KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  hf: "HF_TOKEN",
  gh: "GITHUB_TOKEN",
  gl: "GITLAB_TOKEN",
};

export function applyKeys(keys: Record<string, string | undefined>) {
  for (const [k, name] of Object.entries(KEY_ENV)) {
    if (keys[k]) env[name] = keys[k];
    else delete env[name];
  }
}
