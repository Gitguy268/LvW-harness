/**
 * The models LvW suggests out of the box, shared by the native harness and the web UI.
 * Browser-safe: no node imports.
 *
 * The web UI can only load files under 2 GB (wllama's ArrayBuffer limit), so K2 uses Q4_K_M
 * there and the recommended Q5_K_M natively. Yue2 and Idol need native engines (audio.cpp,
 * idol.cpp); the web UI runs them through a connected LvW-harness.
 */
export type DefaultRole = "chat" | "vision" | "transcribe" | "music" | "3d";

export interface DefaultModel {
  role: DefaultRole;
  name: string;
  repo: string;
  licence: string;
  /** `lvw model pull` spec (chat and vision) or media catalog id (the rest). */
  native: string;
  /** Files the web UI loads itself; absent when it needs the desktop harness. */
  browser?: { files: string[]; sizeGB: number };
  note: string;
}

const HF = "https://huggingface.co";
export const hfResolve = (repo: string, path: string) => `${HF}/${repo}/resolve/main/${path.split("/").map(encodeURIComponent).join("/")}`;

export const DEFAULT_MODELS: DefaultModel[] = [
  {
    role: "chat",
    name: "K2-Horizon 4x0.9B MoE heretic",
    repo: "Lucasgitguy-co/K2-Horizon-4x0.9B-MoE-heretic-GGUF",
    licence: "Apache-2.0",
    native: "hf:Lucasgitguy-co/K2-Horizon-4x0.9B-MoE-heretic-GGUF:Q5_K_M",
    browser: { files: ["K2-Horizon-4x0.9B-MoE-heretic-Q4_K_M.gguf"], sizeGB: 1.87 },
    note: "Small mixture-of-experts chat model with tool calls and reasoning. Q5_K_M natively, Q4_K_M in the browser (2 GB file limit).",
  },
  {
    role: "vision",
    name: "LFM3-VL 2B heretic",
    repo: "Lucasgitguy-co/lfm3-vl-2b-heretic-gguf",
    licence: "LFM Open License v1.0",
    native: "hf:Lucasgitguy-co/lfm3-vl-2b-heretic-gguf:Q4_K_M",
    browser: { files: ["lfm3-vl-2b-heretic-Q4_K_M.gguf", "mmproj-lfm3-vl-2b-heretic-f16.gguf"], sizeGB: 1.48 },
    note: "Answers turns that carry a picture. Comes with its F16 vision projector.",
  },
  {
    role: "transcribe",
    name: "Whisper large-v3-turbo q4_1",
    repo: "oxide-lab/whisper-large-v3-turbo-GGUF",
    licence: "MIT",
    native: "whisper-large-v3-turbo",
    browser: { files: ["whisper.cpp/whisper-large-v3-turbo-q4_1.gguf"], sizeGB: 0.52 },
    note: "Runs on whisper.cpp, so it uses the repo's whisper.cpp/ file. The root .gguf files are Candle-only. In the browser it runs on the CPU and is slow (about 10× the audio length).",
  },
  {
    role: "music",
    name: "Yue2-3B Q4_0",
    repo: "audio-cpp/Yue2-3B-GGUF",
    licence: "CC-BY-NC-4.0 (non-commercial)",
    native: "yue2-3b",
    note: "Songs with vocals, on audio.cpp. Needs the desktop harness.",
  },
  {
    role: "3d",
    name: "Idol Q8_0",
    repo: "TimeLordRaps/Idol-GGUF",
    licence: "Apache-2.0 (encoders under their own gated terms)",
    native: "idol",
    note: "Picture to 3D on idol.cpp. Needs the desktop harness and Hugging Face access to the gated DINOv3 and FLUX.2-dev encoders.",
  },
];

export const defaultFor = (role: DefaultRole) => DEFAULT_MODELS.find((m) => m.role === role)!;
export const DEFAULT_MODEL = defaultFor("chat").native;
export const DEFAULT_VISION_MODEL = defaultFor("vision").native;
