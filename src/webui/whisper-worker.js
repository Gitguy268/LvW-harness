// Speech to text in a Web Worker: whisper.cpp (vendor/whisper) reading the model from a File.
// Messages in:  {type:"load", file: File} | {type:"transcribe", id, audio: Float32Array (16 kHz mono), language, translate}
// Messages out: {type:"loaded", info} | {type:"result", id, text, language} | {type:"error", id?, error}
import createWhisper from "./vendor/whisper/lvw-whisper.js";

let mod;
let loadedName = "";

async function ensureModule() {
  mod ??= await createWhisper({ print: () => {}, printErr: () => {} });
  return mod;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      const w = await ensureModule();
      if (loadedName !== m.file.name) {
        try { w.FS.unmount("/model"); } catch {}
        try { w.FS.mkdir("/model"); } catch {}
        w.FS.mount(w.FS.filesystems.WORKERFS, { files: [m.file] }, "/model");
        if (!w.load(`/model/${m.file.name}`)) throw new Error("whisper.cpp couldn't read this model. It needs a whisper.cpp (ggml) file, such as the ones in a repo's whisper.cpp/ folder.");
        loadedName = m.file.name;
      }
      self.postMessage({ type: "loaded", info: w.systemInfo() });
    } else if (m.type === "transcribe") {
      const w = await ensureModule();
      if (!loadedName) throw new Error("Load a Whisper model first.");
      const threads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
      const text = w.transcribe(m.audio, m.language || "auto", threads, Boolean(m.translate));
      self.postMessage({ type: "result", id: m.id, text: text.trim(), language: w.language() });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, error: err?.message ?? String(err) });
  }
};
