import { resolveChatModel } from "../core/providers.ts";

/** Same prompt, several models, side by side (an idea from odysseus's Compare view). Runs one after another so local models don't fight over memory. */
export async function compareModels(prompt: string, refs: string[]) {
  const out: { model: string; label?: string; text: string; ms: number; tokens?: number; error?: string }[] = [];
  for (const ref of refs.slice(0, 4)) {
    const started = Date.now();
    try {
      const r = await resolveChatModel(ref);
      const msg = await r.models.complete(r.model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      out.push({ model: ref, label: r.label, text: text || msg.errorMessage || "", ms: Date.now() - started, tokens: msg.usage?.output, error: msg.errorMessage });
    } catch (err) {
      out.push({ model: ref, text: "", ms: Date.now() - started, error: (err as Error).message });
    }
  }
  return out;
}
