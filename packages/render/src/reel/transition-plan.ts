import type { Clip, CutIn, Transition } from "@reelwalk/core";

/**
 * How each cut of a reel is drawn with Remotion's TransitionSeries (ADR 0083). Pure, so it is tested without a browser.
 *
 * The schema's kinds map onto Remotion presentations:
 *
 *   cut        none     the clips stay adjacent; no TransitionSeries.Transition at all
 *   fade       fade()   a crossfade (was a dip to black of 8 frames out and 8 in)
 *   walk       none     the 360 walk is drawn inside the incoming clip (PanoView)
 *   softDissolve  softDissolve()  a crossfade with a 3 % breath of scale (ADR 0082, toolbox/presentations.tsx)
 *   focusPull     focusPull()     a rack focus through a soft blur (ADR 0082)
 *   lightLeak     none     a hard cut with a light leak drawn over it (ADR 0082, toolbox/cut-overlays.ts)
 *   occlusionWipe occlusionWipe()  the incoming shot revealed behind an edge that follows the occluder (ADR 0087)
 *   zoomThrough   zoomThrough()    a push into a region of the outgoing shot, the incoming one out of the matching region (ADR 0087)
 * The cut grammar's record on the incoming clip (`clip.cut`, ADR 0087) carries what those two need, and the depth maps
 * that make the focus pull rack through depth; it rides on the plan as `params`.
 * (The whip pan and the speed ramp were retired, ADR 0082: saved ones read as a cut.)
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
      /** The cut grammar's drawing parameters (ADR 0087): the wipe's edge, the zoom's regions, depth maps. */
      params?: CutParams;
    };

export type CutParams = Pick<CutIn, "wipe" | "zoom" | "depth">;

/** The kinds drawn as an overlap of the two clips. */
export type OverlapKind = "fade" | "softDissolve" | "focusPull" | "occlusionWipe" | "zoomThrough";

/**
 * Remotion's transitions guidance: about a third of a second, never more than 12 frames at 30 fps. The cut grammar's
 * two (ADR 0087) keep to the cap: an occluder crosses a phone frame in about that, and a zoom-through longer than
 * 0.4 s reads as a zoom, not a cut.
 */
export const TRANSITION_SECONDS: Record<OverlapKind, number> = { fade: 10 / 30, softDissolve: 12 / 30, focusPull: 12 / 30, occlusionWipe: 12 / 30, zoomThrough: 12 / 30 };
export const MAX_TRANSITION_FRAMES_30 = 12;

/** The presentation a saved kind maps to. */
export function presentationFor(kind: Transition): "none" | OverlapKind {
  return kind === "fade" || kind === "softDissolve" || kind === "focusPull" || kind === "occlusionWipe" || kind === "zoomThrough" ? kind : "none";
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
export function planCuts(clips: readonly { clip: Pick<Clip, "transitionIn" | "cut">; durationInFrames: number }[], fps: number): CutPlan[] {
  return clips.map((entry, index) => {
    if (index === 0) return { kind: "none" };
    const kind = presentationFor(entry.clip.transitionIn);
    if (kind === "none") return { kind: "none" };
    const wanted = transitionFrames(kind, fps);
    const outgoing = clips[index - 1].durationInFrames, incoming = entry.durationInFrames;
    const before = Math.min(Math.floor(wanted / 2), Math.floor(outgoing / 2));
    const after = Math.min(wanted - Math.floor(wanted / 2), Math.floor(incoming / 2));
    if (before + after < 2) return { kind: "none" };
    const params = cutParams(entry.clip.cut);
    return params ? { kind, frames: before + after, before, after, params } : { kind, frames: before + after, before, after };
  });
}

/** The drawing parameters a clip's cut record carries, or undefined when it has none. */
function cutParams(cut: CutIn | undefined): CutParams | undefined {
  if (!cut || (!cut.wipe && !cut.zoom && !cut.depth)) return undefined;
  return { ...(cut.wipe ? { wipe: cut.wipe } : {}), ...(cut.zoom ? { zoom: cut.zoom } : {}), ...(cut.depth ? { depth: cut.depth } : {}) };
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
 * borrow, and a ramped clip's media window is shaped to its own frames (ADR 0067).
 */
export function mediaHandles(
  clip: Pick<Clip, "kind" | "speed" | "sourceStartMs" | "ramp">, sourceDurationMs: number | null | undefined,
  durationInFrames: number, lead: number, tail: number, fps: number,
): { pre: number; post: number } {
  if (clip.kind === "IMAGE" || clip.ramp) return { pre: 0, post: 0 };
  const msPerFrame = (1000 * (clip.speed || 1)) / fps;
  const pre = lead > 0 && clip.sourceStartMs >= Math.ceil(lead * msPerFrame) ? lead : 0;
  const post = tail > 0 && sourceDurationMs != null && clip.sourceStartMs + (durationInFrames + tail + 1) * msPerFrame <= sourceDurationMs ? tail : 0;
  return { pre, post };
}


/**
 * J and L cuts (ADR 0087): a clip's own sound heard across a cut. A J-cut (`cut.jMs` on the incoming clip) starts the
 * incoming clip's sound that long before the cut, from the footage before its in-point; an L-cut (`cut.lMs`) lets the
 * outgoing clip's sound run on that long after the cut, from the footage after its out-point. Each bridge fades
 * (in for a J, out for an L) and is clipped to the source and the clips either side. Pure, so tested without a renderer.
 */
export type SoundBridge = { key: string; assetId: string; from: number; durationInFrames: number; sourceStartMs: number; volume: number; fade: "in" | "out" };

export function soundBridges(
  clips: readonly { clip: Pick<Clip, "id" | "assetId" | "kind" | "volume" | "speed" | "sourceStartMs" | "sourceEndMs" | "audio" | "cut">; from: number; durationInFrames: number }[],
  fps: number, sourceDurationsMs: Record<string, number | null | undefined> = {},
): SoundBridge[] {
  const bridges: SoundBridge[] = [];
  const plays = (clip: (typeof clips)[number]["clip"]) => clip.kind === "VIDEO" && !clip.audio && clip.volume > 0 && (clip.speed || 1) === 1;
  clips.forEach((entry, index) => {
    if (index === 0 || !entry.clip.cut) return;
    const before = clips[index - 1];
    const { jMs, lMs } = entry.clip.cut;
    if (jMs && plays(entry.clip) && before.clip.assetId !== entry.clip.assetId) {
      const ms = Math.min(jMs, entry.clip.sourceStartMs, (before.durationInFrames * 1000) / fps);
      const frames = Math.floor((ms * fps) / 1000);
      if (frames >= 2) bridges.push({ key: `j-${entry.clip.id}`, assetId: entry.clip.assetId, from: entry.from - frames, durationInFrames: frames, sourceStartMs: Math.round(entry.clip.sourceStartMs - (frames * 1000) / fps), volume: entry.clip.volume, fade: "in" });
    }
    if (lMs && plays(before.clip) && before.clip.assetId !== entry.clip.assetId) {
      const source = sourceDurationsMs[before.clip.assetId];
      const room = source == null ? lMs : Math.max(0, source - before.clip.sourceEndMs);
      const ms = Math.min(lMs, room, (entry.durationInFrames * 1000) / fps);
      const frames = Math.floor((ms * fps) / 1000);
      if (frames >= 2) bridges.push({ key: `l-${entry.clip.id}`, assetId: before.clip.assetId, from: entry.from, durationInFrames: frames, sourceStartMs: before.clip.sourceEndMs, volume: before.clip.volume, fade: "out" });
    }
  });
  return bridges;
}
