"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DEFAULT_USER_EMAIL, prisma } from "@reelwalk/db";
import { setActiveWorkspace } from "@/lib/auth";
import { createWorkspaceFor, seatRole } from "@/lib/workspaces";
import { canManage } from "@/lib/workspace-access";
import { getCurrentUser } from "@/lib/workspace";

/**
 * Switches this browser to another of the person's workspaces (ADR 0079). The
 * seat is checked here and again on every request; a workspace the person has
 * no seat in is refused and nothing changes. The editor and export pages of
 * one workspace do not exist in another, so the switch lands on the reels.
 */
export async function switchWorkspace(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const target = String(formData.get("workspaceId") ?? "");
  if (!(await seatRole(user.id, user.homeWorkspaceId, target))) redirect("/account?workspace=denied");
  await setActiveWorkspace(user.id, target);
  revalidatePath("/", "layout");
  redirect("/");
}

/** "Create a workspace": a new, empty workspace the person owns, opened straight away. */
export async function createWorkspace(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (user.email === DEFAULT_USER_EMAIL) redirect(`/account?workspace=${encodeURIComponent("The shared demo studio cannot have more workspaces. Create your own account first.")}#workspaces`);
  const result = await createWorkspaceFor(user.id, user.homeWorkspaceId, String(formData.get("name") ?? ""));
  if (!result.ok) redirect(`/account?workspace=${encodeURIComponent(result.message)}#workspaces`);
  await setActiveWorkspace(user.id, result.id);
  revalidatePath("/", "layout");
  redirect("/?welcome=1");
}

/** Owners turn AI generation on or off for the workspace they are in. Off refuses every AI path server-side (lib/ai-gate.ts). */
export async function setWorkspaceAi(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!canManage(user.role)) redirect("/account?workspace=owner#workspaces");
  await prisma.workspace.update({ where: { id: user.workspaceId }, data: { aiGeneration: formData.get("ai") === "off" ? "off" : "on" } });
  revalidatePath("/", "layout");
  redirect("/account?saved=ai#workspaces");
}
