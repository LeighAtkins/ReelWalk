import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS, TOOLS, runTool, type ToolContext } from "./tools";
import { allow } from "./http";

/**
 * One MCP server per request (ADR 0077): the transport is stateless, so
 * nothing lives between calls and any web instance can answer any call. The
 * tools are bound to the connected person and the scopes their token carries.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "reelwalk", title: "ReelWalk", version: "1.0.0", websiteUrl: `${ctx.origin}/connect` },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        annotations: { title: spec.title, readOnlyHint: spec.readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args) => runTool(spec, ctx, args as Record<string, unknown>, allow),
    );
  }
  return server;
}
