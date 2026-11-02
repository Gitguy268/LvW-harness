import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "./tool.ts";

/** After deepagents' planning tool: a checklist the agent keeps for itself during long work. */
export function todoTool() {
  let items: { text: string; done?: boolean }[] = [];
  return defineTool({
    name: "todo",
    label: "Plan",
    description: "Keep a checklist for work with several steps. Send the whole list each time.",
    risk: "read",
    parameters: Type.Object({
      items: Type.Array(Type.Object({ text: Type.String(), done: Type.Optional(Type.Boolean()) })),
    }),
    async execute(params) {
      items = params.items;
      return items.map((i) => `[${i.done ? "x" : " "}] ${i.text}`).join("\n") || "The list is empty.";
    },
  });
}
