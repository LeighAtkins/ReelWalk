import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@reelwalk/db";
import { appUrl } from "@/lib/app-url";
import { exchangeMessagingCode, isMessagingConfigured } from "@/lib/instagram-messaging";
import { getCurrentUser } from "@/lib/workspace";

/**
 * Instagram's login returns here. The token is kept only when it is for the
 * same account the workspace posts to, so replies come from that account.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const base = await appUrl();
  const back = (status: string) => NextResponse.redirect(`${base}/account?replies=${status}`);
  if (!isMessagingConfigured()) return back("unconfigured");

  const store = await cookies();
  const expected = store.get("rw_igm_state")?.value;
  store.delete("rw_igm_state");
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state || !expected || state !== expected) return back("denied");

  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } } });
  if (!account) return back("no-instagram");
  try {
    const result = await exchangeMessagingCode(code, `${base}/api/instagram/messaging/callback`);
    if (result.username.toLowerCase() !== account.username.toLowerCase()) return back("other-account");
    await prisma.socialAccount.update({
      where: { id: account.id },
      data: { messagingToken: result.accessToken, messagingUserId: result.userId, messagingExpiresAt: result.expiresAt },
    });
    return back("connected");
  } catch (error) {
    console.error("instagram: messaging connect failed", error);
    return back("failed");
  }
}
