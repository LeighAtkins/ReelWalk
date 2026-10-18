"use server";
import { redirect } from "next/navigation";
import { prisma } from "@reelwalk/db";
import { getCurrentUser } from "@/lib/workspace";
export async function saveAiVideoMode(form: FormData): Promise<void> {
  const user = await getCurrentUser();
  const mode = form.get("mode");
  if (mode !== "ASK" && mode !== "AUTO") redirect("/account?error=1");
  const changed = await prisma.workspace.updateMany({ where: { id: user.workspaceId, ...(mode === "AUTO" ? { plan: { not: "FREE" as const } } : {}) }, data: { aiVideoMode: mode } });
  redirect(changed.count ? "/account?saved=1#ai-video-mode" : "/account?message=Automatic%20Veo%20spending%20requires%20a%20paid%20plan.#ai-video-mode");
}
