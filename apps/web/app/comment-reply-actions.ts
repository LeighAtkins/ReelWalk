"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@reelwalk/db";
import { COMMENT_MESSAGE_MAX, normalizeCommentKeyword } from "@reelwalk/core";
import { workspacePlan } from "@/lib/plans";
import { getCurrentUser } from "@/lib/workspace";

const triggerSchema = z.object({
  keyword: z.string().max(40),
  message: z.string().trim().min(1).max(COMMENT_MESSAGE_MAX),
  publicReply: z.string().trim().max(300),
});

/** Adds a keyword, or replaces the message of the one with that keyword (ADR 0026). */
export async function saveCommentTrigger(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!(await workspacePlan(user.workspaceId)).plan.instagram) redirect("/account?instagram=plan");
  const parsed = triggerSchema.safeParse({
    keyword: formData.get("keyword") ?? "",
    message: formData.get("message") ?? "",
    publicReply: formData.get("publicReply") ?? "",
  });
  const keyword = parsed.success ? normalizeCommentKeyword(parsed.data.keyword) : null;
  if (!parsed.success || !keyword) redirect("/account?replies=invalid#replies");
  const data = { message: parsed.data.message, publicReply: parsed.data.publicReply || null, enabled: true };
  await prisma.commentTrigger.upsert({
    where: { workspaceId_keyword: { workspaceId: user.workspaceId, keyword } },
    update: data,
    create: { workspaceId: user.workspaceId, keyword, ...data },
  });
  redirect("/account?replies=saved#replies");
}

export async function toggleCommentTrigger(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const id = String(formData.get("id") ?? "");
  const trigger = await prisma.commentTrigger.findFirst({ where: { id, workspaceId: user.workspaceId } });
  if (trigger) await prisma.commentTrigger.update({ where: { id }, data: { enabled: !trigger.enabled } });
  redirect("/account#replies");
}

export async function deleteCommentTrigger(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  await prisma.commentTrigger.deleteMany({ where: { id: String(formData.get("id") ?? ""), workspaceId: user.workspaceId } });
  redirect("/account#replies");
}

export async function disconnectCommentReplies(): Promise<void> {
  const user = await getCurrentUser();
  await prisma.socialAccount.updateMany({
    where: { workspaceId: user.workspaceId, provider: "instagram" },
    data: { messagingToken: null, messagingUserId: null, messagingExpiresAt: null },
  });
  redirect("/account?replies=disconnected#replies");
}
