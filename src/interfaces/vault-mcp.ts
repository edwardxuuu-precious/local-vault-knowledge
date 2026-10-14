import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LocalVault } from "../application/local-vault.js";

/** Library factory only. No auto-start, locator installation, activation, writes or privileged tools. */
export function createLocalVaultMcpServer(root: string): McpServer {
  const server = new McpServer({ name: "local-vault-knowledge", version: "1.0.0" });
  const answer = async (operation: (vault: LocalVault) => unknown | Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await operation(await LocalVault.open(root))) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: String(error) }] }; }
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("vault_search", { description: "Search current reading text with scope and evidence boundaries",
    inputSchema: { query: z.string().trim().min(1).max(12000), project: z.string().optional() }, annotations },
  ({ query, project }) => answer(vault => vault.search(query, project)));
  server.registerTool("vault_get", { description: "Read full working text; historical state does not validate edits",
    inputSchema: { id: z.string().min(1) }, annotations }, ({ id }) => answer(vault => vault.get(id)));
  server.registerTool("vault_context", { description: "Assemble scoped context; unknown and conflicts remain explicit",
    inputSchema: { task: z.string().min(1).max(12000), workspace: z.string().optional(), project: z.string().optional() }, annotations },
  ({ task, workspace, project }) => answer(vault => vault.buildContext(task, workspace, project)));
  server.registerTool("vault_preview_change", { description: "Preview a base-hash bound change, never apply it",
    inputSchema: { id: z.string().min(1), baseHash: z.string().regex(/^[a-f0-9]{64}$/u), raw: z.string().max(200000) }, annotations },
  ({ id, baseHash, raw }) => answer(vault => vault.previewChange(id, baseHash, raw)));
  return server;
}
