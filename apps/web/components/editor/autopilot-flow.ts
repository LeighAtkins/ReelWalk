import type { Timeline } from "@reelwalk/core";

/** What the autopilot endpoint answers: a whole cut, or why not. */
export type AutopilotCut = { ok: true; timeline: unknown } | { ok: false; message: string };

export type AutopilotSteps<C extends AutopilotCut> = {
  /** The reel and its document generation right now. */
  snapshot(): { timeline: Timeline; generation: number };
  /** The quick first cut by rule, made from `timeline`. Throws when the server cannot be reached. */
  quick(timeline: Timeline): Promise<C>;
  /** The model's polished cut, made from `timeline` (the same input the accepted first cut had). */
  polish(timeline: Timeline): Promise<C>;
  /** Applies a cut as one proposal against `baseGeneration`. */
  takeIn(cut: C & { ok: true }, baseGeneration: number): Promise<{ stale?: true; generation: number }>;
};

export type AutopilotEvents = {
  fail(message: string): void;
  /** The first cut landed: open it in the review while the polish is made. */
  draft(): void;
  polished(): void;
  /** The reel changed after the first cut, so the polish was not applied. */
  polishStale(): void;
  polishFailed(message: string): void;
};

/**
 * "Make it for me" (ADR 0024, 0048). The quick first cut is a proposal
 * against the generation it read; when the reel changed while it was made (a
 * room name landing), it is asked for once more from the reel as it is then.
 * The polish is made from the same input as the first cut that was accepted
 * and applied against that cut's generation, so anything the studio (or a
 * retry) changed before it arrives is never silently replaced.
 */
export async function runAutopilot<C extends AutopilotCut>(steps: AutopilotSteps<C>, events: AutopilotEvents, staleMessage: string): Promise<void> {
  let draft: { input: Timeline; generation: number } | null = null;
  for (let attempt = 0; attempt < 2 && !draft; attempt++) {
    const from = steps.snapshot();
    let quick: C;
    try {
      quick = await steps.quick(from.timeline);
    } catch {
      return events.fail("Could not reach ReelWalk. Check the connection and try again.");
    }
    if (!quick.ok) return events.fail(quick.message);
    const result = await steps.takeIn(quick as C & { ok: true }, from.generation);
    if (!result.stale) draft = { input: from.timeline, generation: result.generation };
  }
  if (!draft) return events.fail(staleMessage);
  events.draft();
  try {
    const polished = await steps.polish(draft.input);
    if (!polished.ok) events.polishFailed(`The first cut stays: ${polished.message}`);
    else if ((await steps.takeIn(polished as C & { ok: true }, draft.generation)).stale) events.polishStale();
    else events.polished();
  } catch {
    events.polishFailed("The first cut stays; the polish could not reach ReelWalk.");
  }
}
