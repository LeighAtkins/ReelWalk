import { preflight } from "@/lib/mcp/http";
import { handleRegister } from "@/lib/mcp/oauth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The MCP connector's OAuth register endpoint (ADR 0077). */
export const POST = handleRegister;
export const OPTIONS = preflight;
