import { NextResponse } from "next/server";
import { prisma } from "@reelwalk/db";
import { isFakeInstagram } from "@/lib/instagram";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const FAKE_TOKEN = "dev-fake-instagram";

/**
 * A pretend Instagram connection for the end-to-end tests on the local stack
 * (DEV_FAKE_INSTAGRAM=true). POST connects it to the signed-in studio unless
 * a real account is already connected; DELETE removes it again. Elsewhere
 * the endpoint does not exist.
 */
export async function POST(): Promise<Response> {
  if (!isFakeInstagram()) return new NextResponse(null, { status: 404 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const existing = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } } });
  if (existing && existing.accessToken !== FAKE_TOKEN) return NextResponse.json({ username: existing.username, fake: false });
  const account = await prisma.socialAccount.upsert({
    where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } },
    update: {},
    create: { workspaceId: user.workspaceId, provider: "instagram", externalId: "17841400000000000", username: "reelwalk.test", accessToken: FAKE_TOKEN },
  });
  return NextResponse.json({ username: account.username, fake: true });
}

export async function DELETE(): Promise<Response> {
  if (!isFakeInstagram()) return new NextResponse(null, { status: 404 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  await prisma.socialAccount.deleteMany({ where: { workspaceId: user.workspaceId, provider: "instagram", accessToken: FAKE_TOKEN } });
  return NextResponse.json({ ok: true });
}
