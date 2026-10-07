import { cache } from "react";
import { redirect } from "next/navigation";
import { DEFAULT_USER_EMAIL, prisma } from "@reelwalk/db";
import { getSessionUser } from "./auth";

/**
 * The signed-in user, or a redirect to the login page. Every page and action
 * goes through this, and every query is scoped to `user.workspaceId`.
 */
export const getCurrentUser = cache(async () => {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
});

/**
 * For the legacy desktop editor's API (apps/editor), which nginx protects
 * with basic auth and which has no session: a signed-in user if there is one,
 * otherwise the seeded demo workspace.
 */
export async function getApiUser() {
  const user = await getSessionUser();
  if (user) return user;
  const demo = await prisma.user.findUnique({ where: { email: DEFAULT_USER_EMAIL }, include: { workspace: true } });
  if (!demo) throw new Error("Demo user missing. Run `pnpm db:seed`.");
  return demo;
}

/**
 * Media a workspace may use: its own uploads plus the open starter library,
 * which is imported once and shared by every workspace.
 */
export function mediaScope(workspaceId: string) {
  return { OR: [{ workspaceId }, { shared: true }] };
}
