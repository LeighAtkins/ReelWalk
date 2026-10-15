import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@reelwalk/db";
import { appUrl } from "@/lib/app-url";
import { isMessagingConfigured, messagingAuthUrl } from "@/lib/instagram-messaging";
import { workspacePlan } from "@/lib/plans";
import { getCurrentUser } from "@/lib/workspace";

/** Starts Instagram's own login for comment replies (ADR 0026). Needs the publishing connection first. */
export async function GET() {
  const user = await getCurrentUser();
  const base = await appUrl();
  if (!isMessagingConfigured()) return NextResponse.redirect(`${base}/account?replies=unconfigured`);
  if (!(await workspacePlan(user.workspaceId)).plan.instagram) return NextResponse.redirect(`${base}/account?instagram=plan`);
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } } });
  if (!account) return NextResponse.redirect(`${base}/account?replies=no-instagram`);

  const state = randomBytes(16).toString("base64url");
  (await cookies()).set("rw_igm_state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600, secure: base.startsWith("https://") });
  return NextResponse.redirect(messagingAuthUrl(`${base}/api/instagram/messaging/callback`, state));
}
