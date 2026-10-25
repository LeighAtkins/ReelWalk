import { json, preflight, siteOrigin } from "@/lib/mcp/http";
import { protectedResourceMetadata } from "@/lib/mcp/oauth-http";

export const dynamic = "force-dynamic";

/** RFC 9728 protected-resource metadata (the form without a path, for clients that ask for the origin's). */
export const GET = (request: Request) => json(protectedResourceMetadata(siteOrigin(request)), 200, { "Cache-Control": "public, max-age=300" });
export const OPTIONS = preflight;
