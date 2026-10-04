import { prisma } from "@reelwalk/db";

export const dynamic = "force-dynamic";

// Readiness: only receive traffic while the database is reachable and the
// migration Job has run (the seeded templates exist).
export async function GET() {
  try {
    const templates = await prisma.template.count();
    if (templates === 0) return Response.json({ ok: false, reason: "not seeded" }, { status: 503 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Readiness check failed", error);
    return Response.json({ ok: false }, { status: 503 });
  }
}
