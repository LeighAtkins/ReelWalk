import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appUrl } from "@/lib/app-url";
import { instagramAuthUrl, isInstagramConfigured } from "@/lib/instagram";
import { workspacePlan } from "@/lib/plans";
import { getCurrentUser } from "@/lib/workspace";

/** Starts Facebook Login for the signed-in user. The state cookie ties the callback to this browser. */
export async function GET() {
  const user = await getCurrentUser();
  const base = await appUrl();
  if (!isInstagramConfigured()) return NextResponse.redirect(`${base}/account?instagram=unconfigured`);
  if (!(await workspacePlan(user.workspaceId)).plan.instagram) return NextResponse.redirect(`${base}/account?instagram=plan`);

  const state = randomBytes(16).toString("base64url");
  (await cookies()).set("rw_ig_state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600, secure: base.startsWith("https://") });
  return NextResponse.redirect(instagramAuthUrl(`${base}/api/instagram/callback`, state));
}
