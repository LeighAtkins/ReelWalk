"use server";

import { isInstagramAudioType } from "@reelwalk/core";
import { searchInstagramAudio, type AudioSearchResult } from "@/lib/instagram-audio";
import { postingProblem } from "@/lib/scheduled-posts";
import { getCurrentUser } from "@/lib/workspace";

/** The "Instagram sound" picker's search: music or trending sounds, trending when the query is empty. */
export async function searchInstagramSounds(input: { type: string; query: string }): Promise<AudioSearchResult> {
  const user = await getCurrentUser();
  if (!isInstagramAudioType(input.type)) return { ok: false, error: "Unknown kind of sound." };
  const problem = await postingProblem(user.workspaceId);
  if (problem) return { ok: false, error: problem };
  return searchInstagramAudio(user.workspaceId, { type: input.type, query: String(input.query ?? "") });
}
