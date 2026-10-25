import { preflight } from "@/lib/mcp/http";
import { handleRevoke } from "@/lib/mcp/oauth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The MCP connector's OAuth revoke endpoint (ADR 0077). */
export const POST = handleRevoke;
export const OPTIONS = preflight;
