import React, { useId } from "react";
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig } from "remotion";
import { linearTiming, type TransitionPresentation, type TransitionPresentationComponentProps, type TransitionTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type { Clip } from "@reelwalk/core";
import { whipAmountAt, type CutPlan, type SlideFrom } from "./transition-plan";
import { whipGeometry } from "./whip";

/**
 * The Remotion presentation and timing of each cut kind (ADR 0083; the mapping is in transition-plan.ts).
 *
 * The fade is Remotion's `fade()`. The whip is our own presentation (the transitions skill's custom-presentation
 * pattern) because, side by side, Remotion's were clearly worse for it (ADR 0083): `slide()` pushes a sharp seam
 * across the frame with no motion blur, and `blur-slide` draws through HTML-in-canvas, which a phone's browser lacks
 * (the Player falls back to a hard cut at the midpoint) and which drew a plain cut in our local render too. Both are
 * CSS and SVG, so the editor's Player on a phone draws exactly what the worker exports.
 */
type AnyPresentation = TransitionPresentation<Record<string, unknown>>;

/** The fade eases in and out (a linear crossfade dips in the middle on bright footage); the whip is fast through its middle. */
const EASING = { fade: Easing.inOut(Easing.quad), whip: Easing.inOut(Easing.cubic) } as const;

/** The camera pan a whip's slide direction came from (transition-plan's slideFrom, inverted). */
const PAN: Record<SlideFrom, NonNullable<Clip["whipDirection"]>> = { "from-right": "right", "from-left": "left", "from-top": "up", "from-bottom": "down" };

type WhipProps = { pan: NonNullable<Clip["whipDirection"]> };

/**
 * The whip pan (whip.ts's geometry, ADR 0083): the outgoing shot streaks away over the first half of the transition
 * and the incoming one streaks in over the second, each displaced, stretched and blurred along the pan, exactly as
 * the clip-level whip drew them before (4 frames out, 4 in), now as a TransitionSeries presentation on Remotion's timing.
 * The blur filter is always mounted, so the footage under it is never remounted as the whip starts or ends.
 */
const WhipPresentation: React.FC<TransitionPresentationComponentProps<WhipProps>> = ({ children, presentationDirection, presentationProgress, passedProps }) => {
  const id = `whip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const at = whipAmountAt(presentationDirection, presentationProgress);
  const shown = at !== null, amount = at ?? 0;
  const g = whipGeometry(amount, passedProps.pan);
  return (
    <AbsoluteFill style={{ visibility: shown ? "visible" : "hidden", overflow: "hidden" }}>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={`${g.blurX} ${g.blurY}`} edgeMode="duplicate" />
        </filter>
      </svg>
      <AbsoluteFill style={amount === 0 ? undefined : { transform: `translate(${g.x}%, ${g.y}%) scale(${g.scaleX}, ${g.scaleY})`, filter: `url(#${id})` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

export function whipPan(pan: NonNullable<Clip["whipDirection"]>): TransitionPresentation<WhipProps> {
  return { component: WhipPresentation, props: { pan } };
}

export function presentationOf(cut: Exclude<CutPlan, { kind: "none" }>): AnyPresentation {
  if (cut.kind === "whip") return whipPan(PAN[cut.direction ?? "from-right"]) as unknown as AnyPresentation;
  return fade() as AnyPresentation;
}

export function timingOf(cut: Exclude<CutPlan, { kind: "none" }>): TransitionTiming {
  return linearTiming({ durationInFrames: cut.frames, easing: EASING[cut.kind] });
}

const noop = () => undefined;

/** One side of one cut around `children`, as TransitionSeries draws it: `progress` 1 entering (or 0 exiting) is at rest. */
const Side: React.FC<{ cut: CutPlan; direction: "entering" | "exiting"; progress: number; children: React.ReactNode }> = ({ cut, direction, progress, children }) => {
  if (cut.kind === "none") return <>{children}</>;
  const presentation = presentationOf(cut);
  const Component = presentation.component;
  return (
    <Component presentationDirection={direction} presentationProgress={progress} presentationDurationInFrames={cut.frames} passedProps={presentation.props}
      onElementImage={noop} onUnmount={noop} bothEnteringAndExiting={false}>
      {children}
    </Component>
  );
};

/**
 * A layer that belongs to one clip but is drawn outside the TransitionSeries (the person and object mattes, which sit
 * above the titles): moved by the same presentation as the footage under it while either of the clip's cuts is
 * running, so the person stays on their own body through a slide or a crossfade. The layer's sequence is the clip's
 * saved span (frame 0 is the saved cut in), so it shows the halves of the transitions inside that span. Both sides are
 * always wrapped (at rest outside their window), so a matte's canvas is never remounted mid-shot.
 */
export const AtCuts: React.FC<{ cutIn: CutPlan; cutOut: CutPlan; durationInFrames: number; children: React.ReactNode }> = ({ cutIn, cutOut, durationInFrames, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = cutIn.kind === "none" ? 1 : progressIn(timingOf(cutIn), frame + cutIn.before, cutIn.frames, fps, 1);
  const exit = cutOut.kind === "none" ? 0 : progressIn(timingOf(cutOut), frame - (durationInFrames - cutOut.before), cutOut.frames, fps, 0);
  return (
    <Side cut={cutIn} direction="entering" progress={enter}>
      <Side cut={cutOut} direction="exiting" progress={exit}>{children}</Side>
    </Side>
  );
};

/** The timing's progress at `local` frames into a window of `frames`, or `rest` outside it. */
function progressIn(timing: TransitionTiming, local: number, frames: number, fps: number, rest: number): number {
  if (local < 0 || local >= frames) return rest;
  return timing.getProgress({ frame: local, fps });
}
