"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { parseTimeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { exportReel } from "@/app/actions";
import { askForChange } from "@/lib/ai-edit";
import { getCurrentUser } from "@/lib/workspace";

export type AskState = { error: string | null; note: string | null; skipped: string[] };

/**
 * "Ask for a change" on the export screen (ADR 0020): applies the request to
 * the saved reel, then either starts a new export or opens the editor on the
 * result. The save carries the reel's revision, so an editor open in another
 * tab is told to reload rather than silently overwritten.
 */
export async function askAndContinue(_previous: AskState, formData: FormData): Promise<AskState> {
  const reelId = String(formData.get("reelId") ?? "");
  const request = String(formData.get("request") ?? "");
  const then = formData.get("then") === "edit" ? "edit" : "export";
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({ where: { id: reelId, workspaceId: user.workspaceId }, select: { id: true, title: true, timeline: true, revision: true } });
  if (!reel) return { error: "This reel was deleted.", note: null, skipped: [] };

  const result = await askForChange({ user, reel, timeline: parseTimeline(reel.timeline), request });
  if (!result.ok) return { error: result.message, note: null, skipped: [] };
  if (result.applied.length === 0) return { error: null, note: result.note, skipped: result.skipped };

  const saved = await prisma.reel.updateMany({
    where: { id: reel.id, workspaceId: user.workspaceId, revision: reel.revision },
    data: { timeline: result.timeline, revision: { increment: 1 } },
  });
  if (saved.count === 0) return { error: "The reel changed in another tab while this was being worked out. Reload and ask again.", note: null, skipped: [] };
  revalidatePath(`/reels/${reel.id}`);

  if (then === "edit") redirect(`/reels/${reel.id}`);
  const exported = await exportReel({ id: reel.id });
  // exportReel redirects when it succeeds; a value means it could not start.
  const why = exported.message ?? exported.issues.map((issue) => issue.message).join(" ");
  return { error: `${result.note} The export could not start: ${why}`, note: null, skipped: result.skipped };
}
