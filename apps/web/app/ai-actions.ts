"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { parseTimeline } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { exportReel } from "@/app/actions";
import { askForChange } from "@/lib/ai-edit";
import { getCurrentUser } from "@/lib/workspace";

export type AskState = { error: string | null; note: string | null; skipped: string[]; upgrade?: boolean };

/** Keeps a brief to cut the next reel with (ADR 0020). Returns the brief as the sheet lists it. */
export async function saveBrief(input: { name: string; text: string }): Promise<{ ok: true; brief: { id: string; name: string; text: string } } | { ok: false; message: string }> {
  const name = input.name.trim().slice(0, 40);
  const text = input.text.trim().slice(0, 600);
  if (!name || text.length < 3) return { ok: false, message: "A preset needs a name and the words to cut with." };
  const user = await getCurrentUser();
  const count = await prisma.reelBrief.count({ where: { workspaceId: user.workspaceId } });
  if (count >= 20) return { ok: false, message: "Twenty presets is the most a studio can keep. Delete one first." };
  const brief = await prisma.reelBrief.create({ data: { workspaceId: user.workspaceId, name, text }, select: { id: true, name: true, text: true } });
  return { ok: true, brief };
}

export async function deleteBrief(input: { id: string }): Promise<{ ok: boolean }> {
  const user = await getCurrentUser();
  const deleted = await prisma.reelBrief.deleteMany({ where: { id: input.id, workspaceId: user.workspaceId } });
  return { ok: deleted.count === 1 };
}

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
  if (!result.ok) return { error: result.message, note: null, skipped: [], upgrade: result.upgrade };
  if (result.applied.length === 0) return { error: null, note: result.note, skipped: result.skipped };

  const saved = await prisma.reel.updateMany({
    where: { id: reel.id, workspaceId: user.workspaceId, revision: reel.revision },
    data: { timeline: result.timeline, revision: { increment: 1 }, ...(result.caption ? { caption: result.caption } : {}) },
  });
  if (saved.count === 0) return { error: "The reel changed in another tab while this was being worked out. Reload and ask again.", note: null, skipped: [] };
  revalidatePath(`/reels/${reel.id}`);

  if (then === "edit") redirect(`/reels/${reel.id}`);
  const exported = await exportReel({ id: reel.id });
  // exportReel redirects when it succeeds; a value means it could not start.
  const why = exported.message ?? exported.issues.map((issue) => issue.message).join(" ");
  return { error: `${result.note} The export could not start: ${why}`, note: null, skipped: result.skipped, upgrade: exported.upgrade };
}
