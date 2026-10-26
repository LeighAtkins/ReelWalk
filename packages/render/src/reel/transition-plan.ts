import type { Clip, Transition } from "@reelwalk/core";

/**
 * How each cut of a reel is drawn with Remotion's TransitionSeries (ADR 0083). Pure, so it is tested without a browser.
 *
 * The schema's kinds map onto Remotion presentations:
 *
 *   cut        none     the clips stay adjacent; no TransitionSeries.Transition at all
 *   fade       fade()   a crossfade (was a dip to black of 8 frames out and 8 in)
 *   whip       whipPan  ours (transitions.tsx): the outgoing shot streaks away the way the camera panned and the next streaks in
 *   walk       none     the 360 walk is drawn inside the incoming clip (PanoView)
 *   softDissolve  softDissolve()  a crossfade with a 3 % breath of scale (ADR 0082, toolbox/presentations.tsx)
 *   focusPull     focusPull()     a rack focus through a soft blur (ADR 0082)
 *   lightLeak     none     a hard cut with a light leak drawn over it (ADR 0082, toolbox/cut-overlays.ts)
 *   speedRamp  none     the ramp's push and blur follow the speed plan inside both clips (ADR 0073/0074)
 *
 * Timing is unchanged. A Remotion transition overlaps the two clips and shortens the timeline, which would move every
 * title, beat and sound after the cut. So each transition is centred on the saved cut instead: the outgoing clip runs
 * `after` frames past it and the incoming clip starts `before` frames early, which lengthens the two sequences by
 * exactly what the overlap takes back. The cut (and so every later frame) stays on the frame it was on, and the
 * transition's midpoint lands on it, as the old whip's did (4 frames out, 4 in).
 *
 * The extra frames come from the footage either side of the clip when the source has them (its handles), and are a
 * held frame when it does not (see ClipView): a photo, a clip that starts at 0, a ramped or speed-planned clip.
 */

/** A Remotion slide direction: where the incoming shot comes from. */
export type SlideFrom = "from-left" | "from-right" | "from-top" | "from-bottom";

export type CutPlan =
  | { kind: "none" }
  | {
      kind: OverlapKind;
      /** The transition's length (frames): `before + after`. */
      frames: number;
      /** Frames of the transition before the saved cut (the incoming clip's early start). */
      before: number;
      /** Frames after it (the outgoing clip's overrun). */
      after: number;
      /** A whip's direction, named as Remotion's slide names it (the side the next shot enters from). */
      direction?: SlideFrom;
    };

/** The kinds drawn as an overlap of the two clips. */
export type OverlapKind = "fade" | "whip" | "softDissolve" | "focusPull";

/** Remotion's transitions guidance: about a third of a second, never more than 12 frames at 30 fps. */
export const TRANSITION_SECONDS: Record<OverlapKind, number> = { fade: 10 / 30, whip: 8 / 30, softDissolve: 12 / 30, focusPull: 12 / 30 };
export const MAX_TRANSITION_FRAMES_30 = 12;

/** The presentation a saved kind maps to. */
export function presentationFor(kind: Transition): "none" | OverlapKind {
  return kind === "fade" || kind === "whip" || kind === "softDissolve" || kind === "focusPull" ? kind : "none";
}

/**
 * The pan's direction (`whipDirection`, where the camera turns) as the side the new shot enters from: a pan to the
 * right moves the picture left, so the next room arrives from the right. Unset is a pan to the right, as before.
 */
export function slideFrom(direction: Clip["whipDirection"]): SlideFrom {
  switch (direction) {
    case "left": return "from-left";
    case "up": return "from-top";
    case "down": return "from-bottom";
    default: return "from-right";
  }
}

/** A transition's length in frames at `fps` for a kind: rounded, at least 2, and capped at 12 frames' worth at 30 fps. */
export function transitionFrames(kind: OverlapKind, fps: number): number {
  const cap = Math.round((MAX_TRANSITION_FRAMES_30 * fps) / 30);
  return Math.max(2, Math.min(cap, Math.round(TRANSITION_SECONDS[kind] * fps)));
}

/**
 * The cut into each clip (index 0 is the reel's opening, always "none": an opening fade from black is the clip's own).
 * Each half of a transition takes at most half of the clip on its side, so a clip's two transitions never overlap and
 * a very short clip shortens (or drops to a cut) the transitions around it rather than breaking the series.
 */
export function planCuts(clips: readonly { clip: Pick<Clip, "transitionIn" | "whipDirection">; durationInFrames: number }[], fps: number): CutPlan[] {
  return clips.map((entry, index) => {
    if (index === 0) return { kind: "none" };
    const kind = presentationFor(entry.clip.transitionIn);
    if (kind === "none") return { kind: "none" };
    const wanted = transitionFrames(kind, fps);
    const outgoing = clips[index - 1].durationInFrames, incoming = entry.durationInFrames;
    const before = Math.min(Math.floor(wanted / 2), Math.floor(outgoing / 2));
    const after = Math.min(wanted - Math.floor(wanted / 2), Math.floor(incoming / 2));
    if (before + after < 2) return { kind: "none" };
    return { kind, frames: before + after, before, after, ...(kind === "whip" ? { direction: slideFrom(entry.clip.whipDirection) } : {}) };
  });
}

/**
 * Each clip's sequence in the TransitionSeries: `lead` frames drawn before its saved start (the transition into it)
 * and `tail` frames after its saved end (the transition out of it). The sum of the sequences minus the transitions is
 * the saved length, so the reel's duration and every cut are unchanged.
 */
export function clipSpans(cuts: readonly CutPlan[]): { lead: number; tail: number }[] {
  return cuts.map((cut, index) => {
    const next = cuts[index + 1];
    return { lead: cut.kind === "none" ? 0 : cut.before, tail: next && next.kind !== "none" ? next.after : 0 };
  });
}

/**
 * Where a cut's transition is at reel frame `frame`, for layers drawn outside the series (the person and object
 * mattes above the titles) that must move with the footage: progress 0..1 while inside the window, null outside it.
 * `cutFrame` is the saved cut (the incoming clip's `from`).
 */
export function cutProgressAt(cut: CutPlan, cutFrame: number, frame: number, timing: (frame: number, frames: number) => number): number | null {
  if (cut.kind === "none") return null;
  const local = frame - (cutFrame - cut.before);
  if (local < 0 || local >= cut.frames) return null;
  return timing(local, cut.frames);
}

/**
 * How many of a clip's `lead` and `tail` frames can be real footage (the rest are a held frame): the source must
 * reach that far before the clip's start and after its end. Only a plain video plays through: a photo has no time to
 * borrow, and a ramped or speed-planned clip's media window is shaped to its own frames (ADR 0067/0073).
 */
export function mediaHandles(
  clip: Pick<Clip, "kind" | "speed" | "sourceStartMs" | "ramp">, planned: boolean, sourceDurationMs: number | null | undefined,
  durationInFrames: number, lead: number, tail: number, fps: number,
): { pre: number; post: number } {
  if (clip.kind === "IMAGE" || clip.ramp || planned) return { pre: 0, post: 0 };
  const msPerFrame = (1000 * (clip.speed || 1)) / fps;
  const pre = lead > 0 && clip.sourceStartMs >= Math.ceil(lead * msPerFrame) ? lead : 0;
  const post = tail > 0 && sourceDurationMs != null && clip.sourceStartMs + (durationInFrames + tail + 1) * msPerFrame <= sourceDurationMs ? tail : 0;
  return { pre, post };
}

/**
 * The whip presentation's schedule (transitions.tsx): over the first half of the transition the outgoing shot whips
 * away (amount 0 → −1), over the second the incoming one whips in (1 → 0); each side is hidden in the other's half.
 * `null` is hidden. Amounts are whip.ts's (positive arriving, negative departing).
 */
export function whipAmountAt(direction: "entering" | "exiting", progress: number): number | null {
  if (direction === "entering") return progress >= 0.5 ? Math.max(0, 1 - (progress - 0.5) * 2) : null;
  return progress < 0.5 ? -Math.min(1, progress * 2) || 0 : null;
}
