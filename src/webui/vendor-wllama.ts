// wllama is copied into vendor/ by scripts/build-webui.ts with its thread-pool patch, and loaded
// from there at run time, so the bundle stays small and the 10 MB wasm is fetched only when needed.
// This file re-exports it with types for the backend.
import type { Wllama as WllamaType } from "@wllama/wllama";

type WllamaCtor = typeof WllamaType;
let ctor: WllamaCtor | undefined;

/** Lazy class: `new Wllama(...)` works after `await loadWllama()`. */
export async function loadWllama(): Promise<WllamaCtor> {
  if (ctor) return ctor;
  const url = new URL("./vendor/wllama/index.js", document.baseURI).href;
  ctor = ((await import(/* @vite-ignore */ url)) as { Wllama: WllamaCtor }).Wllama;
  return ctor;
}

export const Wllama = new Proxy(function () {} as unknown as WllamaCtor, {
  construct(_t, args) {
    if (!ctor) throw new Error("wllama isn't loaded yet; call loadWllama() first.");
    return new (ctor as unknown as new (...a: unknown[]) => object)(...args);
  },
}) as WllamaCtor;
