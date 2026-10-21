import { getSessionUser } from "@/lib/auth";
import { prisma } from "@reelwalk/db";
import { criticFaceFromGeneration } from "@reelwalk/core";

export const runtime = "nodejs";

/**
 * The critic's face facts (ADR 0062) for the AI takes in a reel: whether each
 * shot speaks and the face height and score the identity gate recorded
 * (ADR 0056). Read-only and scoped to the session's workspace; only the
 * numbers the check needs leave the server.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to check the reel." }, { status: 401 });
  const ids = [...new Set((new URL(request.url).searchParams.get("assets") ?? "").split(",").map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  if (!ids.length) return Response.json({ faces: [] });
  const rows = await prisma.aiGeneration.findMany({
    where: { workspaceId: user.workspaceId, assetId: { in: ids } },
    select: { assetId: true, shot: true, identityChecks: true, identityScore: true },
  });
  const faces = rows.flatMap((row) => (row.assetId ? [criticFaceFromGeneration({ ...row, assetId: row.assetId })] : []));
  return Response.json({ faces }, { headers: { "Cache-Control": "private, no-store" } });
}
