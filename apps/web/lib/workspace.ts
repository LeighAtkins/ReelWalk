import { cache } from "react";
import { redirect } from "next/navigation";
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
 * Media a workspace may use: its own uploads plus the open starter library,
 * which is imported once and shared by every workspace.
 */
export function mediaScope(workspaceId: string) {
  return { OR: [{ workspaceId }, { shared: true }] };
}
