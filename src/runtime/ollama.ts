import { loadConfig } from "../config.ts";

const base = () => loadConfig().ollamaUrl.replace(/\/+$/, "");

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  details?: { parameter_size?: string; quantization_level?: string; format?: string };
}

export async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ollamaList(): Promise<OllamaModel[]> {
  const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  return ((await res.json()) as { models: OllamaModel[] }).models ?? [];
}

export async function ollamaPull(name: string, onProgress?: (status: string, done?: number, total?: number) => void, signal?: AbortSignal) {
  const res = await fetch(`${base()}/api/pull`, { method: "POST", body: JSON.stringify({ model: name, stream: true }), signal });
  if (!res.ok || !res.body) throw new Error(`Ollama pull failed (${res.status}). Is Ollama running at ${base()}?`);
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += new TextDecoder().decode(chunk);
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
      if (ev.error) throw new Error(`Ollama: ${ev.error}`);
      onProgress?.(ev.status ?? "", ev.completed, ev.total);
    }
  }
}

export async function ollamaRemove(name: string) {
  const res = await fetch(`${base()}/api/delete`, { method: "DELETE", body: JSON.stringify({ model: name }) });
  if (res.status === 404) throw new Error(`Ollama has no model "${name}".`);
  if (!res.ok) throw new Error(`Ollama delete failed (${res.status})`);
}

export const ollamaOpenAiUrl = () => `${base()}/v1`;
