import React from "react";
import { Easing, useCurrentFrame, useVideoConfig } from "remotion";
import { linearTiming, type TransitionPresentation, type TransitionTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type { CutPlan } from "./transition-plan";
import { focusPull, softDissolve } from "./toolbox/presentations";

/**
 * The Remotion presentation and timing of each cut kind (ADR 0083; the mapping is in transition-plan.ts).
 *
 * The fade is Remotion's `fade()`; the soft dissolve and the focus pull are the toolbox's (ADR 0082). All three are
 * CSS, so the editor's Player on a phone draws exactly what the worker exports. The whip pan that was drawn here was
 * retired (ADR 0082); Remotion's shader transitions draw through HTML-in-canvas, which a phone's browser lacks.
 */
type AnyPresentation = TransitionPresentation<Record<string, unknown>>;

/** The crossfades ease in and out (a linear crossfade dips in the middle on bright footage); the focus pull eases itself. */
const EASING = { fade: Easing.inOut(Easing.quad), softDissolve: Easing.inOut(Easing.quad), focusPull: Easing.linear } as const;

export function presentationOf(cut: Exclude<CutPlan, { kind: "none" }>): AnyPresentation {
  // The toolbox's two (ADR 0082): CSS, so the phone Player draws them too.
  if (cut.kind === "softDissolve") return softDissolve();
  if (cut.kind === "focusPull") return focusPull();
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
