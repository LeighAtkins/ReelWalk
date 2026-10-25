import { json, preflight, siteOrigin } from "@/lib/mcp/http";
import { authorizationServerMetadata } from "@/lib/mcp/oauth-http";

export const dynamic = "force-dynamic";

/** RFC 8414 authorization-server metadata for the MCP connector (ADR 0077). */
export const GET = (request: Request) => json(authorizationServerMetadata(siteOrigin(request)), 200, { "Cache-Control": "public, max-age=300" });
export const OPTIONS = preflight;
