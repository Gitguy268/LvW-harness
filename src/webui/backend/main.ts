// The web UI's in-page harness. Must load before app.js: it sets window.LVW_BACKEND, which
// app.js uses unless the page is connected to a desktop LvW-harness.
import "./env.ts";
import "./net.ts";
import * as hub from "./hub.ts";
import { previewBlob } from "./files.ts";

const ready = hub.init().catch((err: Error) => {
  console.error(err);
  throw err;
});

(window as unknown as { LVW_BACKEND: unknown }).LVW_BACKEND = {
  kind: "browser",
  label: "this browser",
  async request(path: string, opts?: { method?: string; body?: unknown }) {
    await ready;
    return hub.request(path, opts);
  },
  connect(onMessage: (m: unknown) => void, onState?: (up: boolean) => void) {
    void ready.then(() => hub.connect(onMessage as never, onState));
  },
  send(m: Record<string, unknown> & { type: string }) {
    void ready.then(() => hub.send(m));
  },
  async upload(files: File[]) {
    await ready;
    return hub.upload(files);
  },
  mediaUrl: () => "",
  previewUrl: async (path: string) => {
    await ready;
    return previewBlob(path);
  },
};
