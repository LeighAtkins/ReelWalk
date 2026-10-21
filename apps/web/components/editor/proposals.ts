import { sameTimeline, type InstagramAudioTrack, type MusicChoice, type Timeline } from "@reelwalk/core";
import { STALE_PROPOSAL, type DocumentStore } from "./document-store";

/** What the editor shows when a proposal arrived but is not a reel it can open. */
export const REJECTED_PROPOSAL = "ReelWalk's suggestion could not be applied (it was not a valid reel), so nothing changed. Try asking again.";

/** How a proposal fared: landed (the new generation and reel), or not, and why. */
export type Landed = { ok: true; generation: number; timeline: Timeline } | { ok: false; reason: "stale" | "rejected"; message: string };

export type ProposalDeps = Pick<DocumentStore, "runCommand" | "snapshot"> & {
  /** Gets an Instagram sound ready to set, without changing the reel; null when it could not. */
  fetchSound(track: InstagramAudioTrack): Promise<MusicChoice | null>;
};

/**
 * The one way an async proposal (Ask, Make it for me, the director) is
 * applied (ADR 0048): against the generation it was computed for, with the
 * song it chose fetched first and snapped to in the same step. A stale or
 * rejected proposal is a failure with a message, never a silent success.
 */
export async function landProposal(deps: ProposalDeps, baseGeneration: number, proposal: unknown, pick?: InstagramAudioTrack | null): Promise<Landed> {
  const stale: Landed = { ok: false, reason: "stale", message: STALE_PROPOSAL };
  // Not worth fetching a song for a reel that has already moved on.
  if (deps.snapshot().generation !== baseGeneration) return stale;
  const music = pick ? await deps.fetchSound(pick) : null;
  const result = deps.runCommand({ type: "applyProposal", baseGeneration, proposal, ...(music ? { music: { ...music, snap: true } } : {}) });
  if (result.stale) return stale;
  if (result.rejected) return { ok: false, reason: "rejected", message: REJECTED_PROPOSAL };
  return { ok: true, generation: result.generation, timeline: result.timeline };
}

/**
 * The generation a director review was asked against. One asked in this
 * session carries it; one saved earlier has none and counts as made against
 * the current reel only if it is the same edit.
 */
export function reviewGeneration(deps: Pick<DocumentStore, "snapshot">, review: { generation?: number; baseline: unknown }): number {
  if (review.generation !== undefined) return review.generation;
  const now = deps.snapshot();
  return sameTimeline(now.timeline, review.baseline) ? now.generation : -1;
}
