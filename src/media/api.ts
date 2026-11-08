/**
 * HTTP clients for OpenAI-style media endpoints and Replicate. Local Ollama speaks the same
 * /v1/audio/* API as OpenAI, so speech and transcription share one client.
 */

export interface OpenAiTarget {
  baseUrl: string;
  key?: string;
}

const auth = (t: OpenAiTarget): Record<string, string> => (t.key ? { authorization: `Bearer ${t.key}` } : {});

async function failure(res: Response, what: string) {
  const text = (await res.text()).slice(0, 400);
  let msg = text;
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    msg = typeof j.error === "string" ? j.error : (j.error?.message ?? text);
  } catch {}
  return new Error(`${what} failed (${res.status}): ${msg}`);
}

export async function speech(t: OpenAiTarget, req: { model: string; input: string; voice?: string }, signal?: AbortSignal): Promise<Uint8Array> {
  const body: Record<string, unknown> = { model: req.model, input: req.input, response_format: "wav" };
  if (req.voice) body.voice = req.voice;
  const res = await fetch(`${t.baseUrl}/audio/speech`, { method: "POST", headers: { "content-type": "application/json", ...auth(t) }, body: JSON.stringify(body), signal });
  if (!res.ok) throw await failure(res, "Text to speech");
  return new Uint8Array(await res.arrayBuffer());
}

export async function transcribe(t: OpenAiTarget, req: { model: string; audio: Uint8Array; filename?: string; language?: string; translate?: boolean }, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(req.audio)], { type: "audio/wav" }), req.filename ?? "audio.wav");
  form.append("model", req.model);
  form.append("response_format", "json");
  if (req.language) form.append("language", req.language);
  const res = await fetch(`${t.baseUrl}/audio/${req.translate ? "translations" : "transcriptions"}`, { method: "POST", headers: auth(t), body: form, signal });
  if (!res.ok) throw await failure(res, "Transcription");
  return ((await res.json()) as { text?: string }).text?.trim() ?? "";
}

export async function openAiImage(t: OpenAiTarget, req: { model: string; prompt: string; width?: number; height?: number }, signal?: AbortSignal): Promise<Uint8Array> {
  const size = req.width && req.height ? `${req.width}x${req.height}` : "1024x1024";
  const res = await fetch(`${t.baseUrl}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(t) },
    body: JSON.stringify({ model: req.model, prompt: req.prompt, size, n: 1 }),
    signal,
  });
  if (!res.ok) throw await failure(res, "Image generation");
  const item = ((await res.json()) as { data?: { b64_json?: string; url?: string }[] }).data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) return new Uint8Array(await (await fetch(item.url, { signal })).arrayBuffer());
  throw new Error("The image API returned no image.");
}

/**
 * Run a Replicate model ("owner/name" or "owner/name:version") and download its first output file.
 * Input names differ between models; the common ones (prompt, image, duration) are sent.
 */
export async function replicate(token: string, model: string, input: Record<string, unknown>, opts: { signal?: AbortSignal; onStatus?: (s: string) => void } = {}): Promise<{ data: Uint8Array; mime: string }> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "wait=60" };
  const [ref, version] = model.split(":");
  const url = version ? "https://api.replicate.com/v1/predictions" : `https://api.replicate.com/v1/models/${ref}/predictions`;
  let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(version ? { version, input } : { input }), signal: opts.signal });
  if (!res.ok) throw await failure(res, `Replicate ${model}`);
  let p = (await res.json()) as { status: string; output?: unknown; error?: string; urls?: { get?: string } };
  while (p.status === "starting" || p.status === "processing") {
    opts.onStatus?.(`Replicate: ${p.status}`);
    await Bun.sleep(2000);
    res = await fetch(p.urls!.get!, { headers, signal: opts.signal });
    if (!res.ok) throw await failure(res, `Replicate ${model}`);
    p = (await res.json()) as typeof p;
  }
  if (p.status !== "succeeded") throw new Error(`Replicate ${model} ${p.status}: ${p.error ?? "no output"}`);
  const out = Array.isArray(p.output) ? p.output[0] : typeof p.output === "object" && p.output ? Object.values(p.output)[0] : p.output;
  if (typeof out !== "string" || !out.startsWith("http")) throw new Error(`Replicate ${model} returned no file.`);
  const file = await fetch(out, { signal: opts.signal });
  if (!file.ok) throw await failure(file, "Downloading the Replicate result");
  return { data: new Uint8Array(await file.arrayBuffer()), mime: file.headers.get("content-type") ?? "application/octet-stream" };
}

/** True when the bytes are a RIFF/WAVE file. */
export function isWav(b: Uint8Array) {
  return b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WAVE";
}

/** Ollama only reads WAV. Convert other audio with ffmpeg when it is installed. */
export async function toWav(b: Uint8Array): Promise<Uint8Array> {
  if (isWav(b)) return b;
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("Only WAV audio can be read without ffmpeg. Install ffmpeg, or convert the file to WAV first.");
  const proc = Bun.spawn([ffmpeg, "-loglevel", "error", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"], { stdin: b, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`ffmpeg couldn't read the audio: ${err.trim().slice(0, 200)}`);
  return new Uint8Array(out);
}
