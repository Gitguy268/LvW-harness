/**
 * One fetch for the whole web UI:
 *  - requests to http://wllama.lvw/v1/... are answered by the in-page model (see llm.ts), so the
 *    harness's normal OpenAI-compatible path (the same one llama-server uses natively) runs here;
 *  - a cross-origin request the browser blocks (CORS) is retried through the CORS proxy from
 *    Settings, when one is set. GitHub release files and gitlab.com /-/ links need that.
 */
export const LOCAL_BASE = "http://wllama.lvw/v1";

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let localHandler: Handler | undefined;
let proxy: string | undefined;

export const setLocalHandler = (h: Handler) => (localHandler = h);
export const setCorsProxy = (p?: string) => (proxy = p?.trim() || undefined);

const nativeFetch = globalThis.fetch.bind(globalThis);

function urlOf(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Hosts known to send no CORS headers for downloads. */
const NO_CORS = /^https:\/\/(github\.com\/[^/]+\/[^/]+\/releases\/download\/|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|gitlab\.com\/[^?]*\/-\/(raw|releases|archive))/;

export class CorsError extends Error {
  constructor(url: string) {
    super(
      `The browser blocked ${new URL(url).host}: that server doesn't allow web pages to download from it (no CORS headers). Set a CORS proxy in Settings, or connect this page to your LvW-harness, which downloads directly.`,
    );
    this.name = "CorsError";
  }
}

export const viaProxy = (url: string) => (proxy ? (proxy.includes("{url}") ? proxy.replace("{url}", encodeURIComponent(url)) : proxy + encodeURIComponent(url)) : url);

export async function lvwFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = urlOf(input);
  if (url.startsWith(LOCAL_BASE) && localHandler) return localHandler(url, init ?? (input instanceof Request ? { method: input.method, headers: input.headers, body: await input.text() } : undefined));
  const cross = /^https?:/.test(url) && new URL(url).origin !== location.origin;
  if (cross && proxy && NO_CORS.test(url)) return nativeFetch(viaProxy(url), init);
  try {
    return await nativeFetch(input, init);
  } catch (err) {
    if (!cross || (err as Error).name === "AbortError") throw err;
    if (proxy) return nativeFetch(viaProxy(url), init);
    throw NO_CORS.test(url) ? new CorsError(url) : err;
  }
}

globalThis.fetch = lvwFetch as typeof fetch;
