import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@reelwalk/db";
import { appUrl } from "@/lib/app-url";
import { exchangeCode, isInstagramConfigured, listInstagramAccounts } from "@/lib/instagram";
import { getCurrentUser } from "@/lib/workspace";

/** Facebook Login returns here. Stores the first Instagram professional account found on the user's Pages. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const base = await appUrl();
  const back = (status: string) => NextResponse.redirect(`${base}/account?instagram=${status}`);
  if (!isInstagramConfigured()) return back("unconfigured");

  const store = await cookies();
  const expected = store.get("rw_ig_state")?.value;
  store.delete("rw_ig_state");
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state || !expected || state !== expected) return back("denied");

  try {
    const { accessToken, expiresAt } = await exchangeCode(code, `${base}/api/instagram/callback`);
    const accounts = await listInstagramAccounts(accessToken);
    const account = accounts[0];
    if (!account) return back("no-account");
    await prisma.socialAccount.upsert({
      where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } },
      update: { externalId: account.id, username: account.username, accessToken, expiresAt },
      create: { workspaceId: user.workspaceId, provider: "instagram", externalId: account.id, username: account.username, accessToken, expiresAt },
    });
    return back("connected");
  } catch (error) {
    console.error("instagram: connect failed", error);
    return back("failed");
  }
}
