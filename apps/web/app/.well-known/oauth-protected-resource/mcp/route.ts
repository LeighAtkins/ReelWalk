import { json, preflight, siteOrigin } from "@/lib/mcp/http";
import { protectedResourceMetadata } from "@/lib/mcp/oauth-http";

export const dynamic = "force-dynamic";

/** RFC 9728 protected-resource metadata for /mcp: where the 401's resource_metadata points (ADR 0077). */
export const GET = (request: Request) => json(protectedResourceMetadata(siteOrigin(request)), 200, { "Cache-Control": "public, max-age=300" });
export const OPTIONS = preflight;
