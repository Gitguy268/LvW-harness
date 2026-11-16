/** Speech to text in the browser: whisper.cpp in a Web Worker (whisper-worker.js), CPU only. */
import { findModel, openModelRaw } from "./models.ts";

let worker: Worker | undefined;
let loaded = "";
let seq = 0;
const pending = new Map<number, { resolve: (v: { text: string; language: string }) => void; reject: (e: Error) => void }>();
let loadWait: { resolve: () => void; reject: (e: Error) => void } | undefined;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./whisper-worker.js", document.baseURI), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "loaded") loadWait?.resolve();
    else if (m.type === "result") pending.get(m.id)?.resolve({ text: m.text, language: m.language }), pending.delete(m.id);
    else if (m.type === "error") {
      if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)!.reject(new Error(m.error)), pending.delete(m.id);
      else loadWait?.reject(new Error(m.error));
    }
  };
  return worker;
}

/** Any audio the browser can decode → 16 kHz mono samples. */
export async function decode16k(bytes: ArrayBuffer): Promise<Float32Array> {
  const probe = new OfflineAudioContext(1, 1, 16000);
  const decoded = await probe.decodeAudioData(bytes.slice(0));
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

export async function transcribe(modelRef: string, audio: ArrayBuffer, opts: { language?: string; translate?: boolean; onStatus?: (s: string) => void } = {}) {
  if (!crossOriginIsolated) throw new Error("Speech to text needs this page to be cross-origin isolated. Reload the page once (the service worker sets it up).");
  const m = await findModel(modelRef);
  if (!m) throw new Error(`No downloaded Whisper model "${modelRef}". Get Whisper on the Models page.`);
  const w = ensureWorker();
  if (loaded !== m.name) {
    opts.onStatus?.(`Loading ${m.name}…`);
    const [file] = await openModelRaw(m);
    await new Promise<void>((resolve, reject) => {
      loadWait = { resolve, reject };
      w.postMessage({ type: "load", file });
    });
    loaded = m.name;
  }
  opts.onStatus?.("Listening (on the CPU, this takes a while)…");
  const samples = await decode16k(audio);
  const id = ++seq;
  return new Promise<{ text: string; language: string }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "transcribe", id, audio: samples, language: opts.language, translate: opts.translate }, [samples.buffer]);
  });
}
