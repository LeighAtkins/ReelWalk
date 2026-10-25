import { preflight } from "@/lib/mcp/http";
import { handleToken } from "@/lib/mcp/oauth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The MCP connector's OAuth token endpoint (ADR 0077). */
export const POST = handleToken;
export const OPTIONS = preflight;
