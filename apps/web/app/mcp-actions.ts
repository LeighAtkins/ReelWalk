"use server";

import { redirect } from "next/navigation";
import { revokeGrant } from "@/lib/mcp/oauth-store";
import { getCurrentUser } from "@/lib/workspace";

/** Account page, Connected apps: ends one app's access. Every token it holds stops working at once (ADR 0077). */
export async function disconnectApp(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const grantId = formData.get("grantId");
  if (typeof grantId === "string" && grantId) await revokeGrant(user.id, grantId);
  redirect("/account?saved=app#apps");
}
