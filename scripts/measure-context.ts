// Rough size of what every request sends before the first message: system prompt + tool schemas.
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Session } from "../src/core/session.ts";
import { browserTools } from "../src/tools/browser.ts";

const f = fauxProvider();
const models = createModels();
models.setProvider(f.provider);
const s = await Session.create({ cwd: process.cwd(), resolved: { models, model: f.getModel(), label: "faux", local: true }, persist: false });
const size = (tools: { name: string; description: string; parameters: unknown }[]) => JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length;
const tok = (chars: number) => Math.round(chars / 3.5);
const prompt = s.agent.state.systemPrompt.length;
console.log(`tools (${s.tools.length}): ~${tok(size(s.tools))} tokens`);
console.log(`browser (${browserTools(s.ctx).length}): ~${tok(size(browserTools(s.ctx)))} tokens`);
console.log(`system prompt: ~${tok(prompt)} tokens`);
await s.dispose();
