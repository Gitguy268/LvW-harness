export interface RemoteFile {
  /** Path inside the model folder, e.g. `Qwen3-4B-Q4_K_M.gguf` or `onnx/model.onnx`. */
  path: string;
  url: string;
  size?: number;
  sha256?: string;
  headers?: Record<string, string>;
  /** Some git hosts serve LFS pointers from raw URLs; this URL serves the real object. */
  lfsUrl?: string;
}

export interface ResolvedModel {
  /** Folder under ~/.lvw/models, e.g. `hf/Qwen/Qwen3-4B-GGUF`. */
  dir: string;
  /** Every file the source offers. */
  available: RemoteFile[];
  /** What a pull downloads when the user doesn't choose. */
  selected: RemoteFile[];
  /** Short default name for the registry. */
  name: string;
  /** Extra info for `model info`. */
  note?: string;
}

export interface ModelRecord {
  id: string;
  name: string;
  source: string;
  spec: string;
  dir: string;
  files: string[];
  mainFile?: string;
  size: number;
  format: string;
  addedAt: number;
  lastUsed?: number;
}

export type PullEvent =
  | { type: "resolved"; name: string; files: { path: string; size?: number }[]; total: number }
  | { type: "progress"; file: string; done: number; total: number; fileDone: number; fileTotal?: number }
  | { type: "verify"; file: string }
  | { type: "status"; text: string }
  | { type: "done"; model: ModelRecord };
