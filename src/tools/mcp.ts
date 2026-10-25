import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "@earendil-works/pi-ai";
import type { McpServerConfig } from "../config.ts";
import type { LvwTool } from "./tool.ts";

/** Connected MCP servers, shared by every session in this process. */
const clients = new Map<string, Promise<{ client: McpClient; tools: LvwTool[] }>>();

async function connect(name: string, cfg: McpServerConfig, cwd: string) {
  const client = new McpClient({ name: "lvw-harness", version: "0.1.0", roots: [{ uri: `file://${cwd}`, name: "workspace" }] });
  const transport = cfg.url
    ? new StreamableHttpTransport({ url: cfg.url, headers: cfg.headers })
    : new StdioTransport({ command: cfg.command!, args: cfg.args ?? [], cwd, env: cfg.env, inheritEnv: true, stderr: "pipe" });
  let listed;
  try {
    await client.connect(transport);
    listed = await client.listTools();
  } catch (err) {
    // A server that crashes on start usually says why on stderr.
    const why = transport instanceof StdioTransport ? transport.stderr.trim().split("\n").at(-1) : undefined;
    await client.close().catch(() => {});
    throw why ? new Error(`${(err as Error).message}: ${why}`) : err;
  }
  const tools: LvwTool[] = listed.map((tool) => ({
    // Providers allow at most 64 characters of [A-Za-z0-9_-].
    name: `mcp_${name}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
    label: `${name}: ${tool.title ?? tool.name}`,
    description: tool.description ?? tool.name,
    parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
    risk: tool.annotations?.readOnlyHint ? "read" : "external",
    execute: async (_id, params, signal) => {
      const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
      return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
    },
  }));
  return { client, tools };
}

export async function mcpTools(servers: Record<string, McpServerConfig>, cwd: string, onError?: (name: string, err: Error) => void): Promise<LvwTool[]> {
  const out: LvwTool[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg.url && !cfg.command) continue;
    if (!clients.has(name)) clients.set(name, connect(name, cfg, cwd));
    try {
      out.push(...(await clients.get(name)!).tools);
    } catch (err) {
      clients.delete(name);
      onError?.(name, err as Error);
    }
  }
  return out;
}

export async function closeMcp() {
  for (const p of clients.values()) {
    try {
      await (await p).client.close();
    } catch {}
  }
  clients.clear();
}
