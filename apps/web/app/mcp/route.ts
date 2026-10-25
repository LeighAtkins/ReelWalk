import { handleMcp } from "@/lib/mcp/endpoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ReelWalk MCP connector (ADR 0077). See lib/mcp/endpoint.ts. */
export { handleMcp as GET, handleMcp as POST, handleMcp as DELETE, handleMcp as OPTIONS };
