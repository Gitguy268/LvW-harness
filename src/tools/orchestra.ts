import { Type } from "@earendil-works/pi-ai";
import { createTask, listTasks, requestApproval, STATUSES, updateTask, type TaskStatus } from "../orchestra/tasks.ts";
import { defineTool, type ToolContext } from "./tool.ts";

export function taskTools(ctx: ToolContext) {
  return [
    defineTool({
      name: "task_list",
      label: "Tasks",
      description: "List open tasks on the task board.",
      risk: "read",
      parameters: Type.Object({ include_done: Type.Optional(Type.Boolean()) }),
      async execute({ include_done }) {
        const tasks = listTasks({ includeDone: include_done });
        return tasks.length ? tasks.map((t) => `#${t.id} [${t.status}] ${t.title}${t.owner ? ` (${t.owner})` : ""}`).join("\n") : "No open tasks.";
      },
    }),
    defineTool({
      name: "task_create",
      label: "New task",
      description: "Add a task to the board, e.g. to split up a big job or leave follow-up work.",
      risk: "write",
      parameters: Type.Object({ title: Type.String(), description: Type.Optional(Type.String()), parent_id: Type.Optional(Type.Number()) }),
      async execute({ title, description, parent_id }) {
        const t = createTask({ title, description, parentId: parent_id ?? ctx.taskId, owner: "lvw" });
        return `Created task #${t.id}`;
      },
    }),
    defineTool({
      name: "task_update",
      label: "Update task",
      description: `Change a task's status (${STATUSES.join(", ")}), add a note, or record its result.`,
      risk: "write",
      parameters: Type.Object({
        id: Type.Number(),
        status: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
        result: Type.Optional(Type.String()),
      }),
      async execute({ id, status, note, result }) {
        const t = updateTask(id, { status: status as TaskStatus | undefined, note, result });
        return `Task #${t.id} is ${t.status}`;
      },
    }),
    defineTool({
      name: "request_approval",
      label: "Ask for approval",
      description: "Stop and ask a person to approve a decision before going on (spending money, publishing, deleting data…).",
      risk: "read",
      parameters: Type.Object({ question: Type.String() }),
      async execute({ question }) {
        const a = requestApproval(question, ctx.taskId, ctx.sessionId);
        return {
          content: [{ type: "text", text: `Approval #${a.id} requested. Stop here; the work continues once a person approves it (lvw task approve ${a.id}, or the web UI).` }],
          details: undefined,
          terminate: true,
        };
      },
    }),
  ];
}
