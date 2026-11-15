// Browser stand-in for src/credentials.ts (the build swaps it in): tokens come from Settings.
import { env, KEY_ENV } from "./env.ts";

export type Service = "hf" | "gh" | "gl" | "telegram" | "openai" | "replicate";

export function getToken(service: Service): string | undefined {
  const name = KEY_ENV[service];
  return name ? env[name] || undefined : undefined;
}

export function setToken() {
  throw new Error("Set keys and tokens in Settings.");
}
