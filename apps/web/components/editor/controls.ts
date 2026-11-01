import type { Clip, TextOverlay, Timeline } from "@reelwalk/core";

/**
 * The contextual control registry (ADR 0064). Power is reached by tapping the
 * thing it affects: a title, a clip, the presenter, the music, or nothing
 * (the reel). Each control declares which of those it belongs to, when it
 * shows, and where it sits; the editor turns the list for the current
 * selection into the toolbar. New features add an entry here (or in
 * control-extensions.tsx, with their own panel) instead of a new global
 * button, so the bottom bar stays short.
 *
 * Pure: no React, so the rules for what shows where are unit-tested.
 */

/** What a control changes. "presenter" is an AI-generated take; it is also a clip, so it gets both lists. */
export type ControlTarget = "reel" | "clip" | "presenter" | "text" | "music";

/** What the rules can see about the reel and the thing tapped. */
export type ControlContext = {
  timeline: Timeline;
  clip: Clip | null;
  clipIndex: number;
  text: TextOverlay | null;
  /** The selected clip's media. */
  asset: { kind: string; isPano: boolean; isPresenterTake?: boolean } | null;
  askAvailable: boolean;
  /** AI generation is switched off for this workspace (ADR 0079): the AI controls are not offered. */
  aiOff?: boolean;
  /** Instagram's sounds are offered on this deployment. */
  instagram: boolean;
};

export type ControlSpec = {
  id: string;
  label: string | ((context: ControlContext) => string);
  /** The accessible name when the visible label is a short form ("Pop" for "Make it pop"). */
  ariaLabel?: string;
  targets: readonly ControlTarget[];
  /** Lower first. On a 412 px phone the first five fit without scrolling. */
  order: number;
  /** "bar" (default): in the toolbar. "more": in the Reel sheet, for reel-wide settings used now and then. */
  place?: "bar" | "more";
  when?(context: ControlContext): boolean;
  /** Who mounts it: the editor itself, or the workstream/ADR that added it. */
  owner?: string;
};

const isVideo = (c: ControlContext) => c.clip?.kind === "VIDEO";
const isPanoClip = (c: ControlContext) => Boolean(c.asset?.isPano || c.clip?.pano);
/** The first shot carries the hook (ADR 0041), and so does a title that opens the reel or one of the hook's own words. */
const carriesHook = (c: ControlContext) => (c.clip ? c.clipIndex === 0 : c.text ? c.text.id.startsWith("hook-word-") || c.text.startMs < 300 : false);

/**
 * The editor's own controls. Every capability the old toolbars and global
 * sheets had is here; ids are what the editor binds handlers to.
 */
export const BUILT_IN_CONTROLS: readonly ControlSpec[] = [
  // ── Nothing selected: the reel ──
  { id: "text-new", label: "Text", targets: ["reel"], order: 10 },
  { id: "music-open", label: "Music", targets: ["reel"], order: 20 },
  { id: "media", label: "Add media", targets: ["reel"], order: 30 },
  // Short on the button so all six fit a 412 px phone; the full name is what is announced.
  { id: "finish-pop", label: "Pop", ariaLabel: "Make it pop", targets: ["reel"], order: 40 },
  { id: "finish-premium", label: "Premium", ariaLabel: "Make it premium", targets: ["reel"], order: 50 },
  { id: "reel-more", label: "Reel", targets: ["reel"], order: 90 },
  // In the Reel sheet: reel-wide settings.
  { id: "pace", label: "Pace", targets: ["reel"], order: 10, place: "more" },
  { id: "look-all", label: "Look", targets: ["reel"], order: 20, place: "more" },
  { id: "words", label: "Words", targets: ["reel"], order: 30, place: "more" },
  { id: "hook", label: "Hook", targets: ["reel"], order: 40, place: "more" },
  { id: "details", label: "Details", targets: ["reel"], order: 50, place: "more" },
  { id: "caption", label: "Caption", targets: ["reel"], order: 60, place: "more" },
  { id: "logo", label: "Logo", targets: ["reel"], order: 70, place: "more" },
  // A board of panels side by side (ADR 0106).
  { id: "board", label: "Board", targets: ["reel"], order: 75, place: "more" },
  { id: "plan", label: "Floor plan", targets: ["reel"], order: 80, place: "more", when: (c) => c.timeline.plan !== null && c.timeline.plan !== undefined },
  { id: "ai-video", label: "AI video", targets: ["reel"], order: 90, place: "more", when: (c) => !c.aiOff },
  { id: "director", label: "Ask Opus", targets: ["reel"], order: 95, place: "more", when: (c) => c.askAvailable },
  { id: "split", label: "Split", targets: ["reel"], order: 100, place: "more" },
  { id: "guides", label: "Guides", targets: ["reel"], order: 110, place: "more" },
  { id: "delete-reel", label: "Delete reel", targets: ["reel"], order: 200, place: "more" },

  // ── A clip ──
  { id: "trim", label: (c) => (isVideo(c) ? "Trim" : "Length"), targets: ["clip"], order: 10 },
  { id: "speed", label: "Speed", targets: ["clip"], order: 20, when: isVideo },
  { id: "zoom", label: "Zoom", targets: ["clip"], order: 30 },
  { id: "replace", label: "Replace", targets: ["clip"], order: 40 },
  { id: "hook", label: "Hook", targets: ["clip"], order: 45, when: carriesHook },
  { id: "split", label: "Split", targets: ["clip"], order: 50 },
  { id: "volume", label: "Volume", targets: ["clip"], order: 60, when: isVideo },
  { id: "pano", label: "360 view", targets: ["clip"], order: 65, when: (c) => !isVideo(c) && isPanoClip(c) },
  { id: "motion", label: "Motion", targets: ["clip"], order: 70, when: (c) => isVideo(c) || !c.clip?.pano },
  { id: "look", label: "Look", targets: ["clip"], order: 80 },
  { id: "cover", label: "Cover", targets: ["clip"], order: 90 },
  { id: "fit", label: (c) => (c.clip?.fit === "cover" ? "Fit" : "Fill"), targets: ["clip"], order: 100 },
  { id: "transition", label: "Transition", targets: ["clip"], order: 110 },
  { id: "duplicate", label: "Duplicate", targets: ["clip"], order: 120 },
  { id: "earlier", label: "Earlier", targets: ["clip"], order: 130 },
  { id: "later", label: "Later", targets: ["clip"], order: 140 },

  // ── The presenter (an AI take): before the clip tools ──
  // Both open the script sheet (ADR 0060): her lines, voice and takes for the whole reel.
  { id: "redo-take", label: "Redo take", targets: ["presenter"], order: 1, when: (c) => !c.aiOff },
  { id: "new-take", label: "New take", targets: ["presenter"], order: 2, when: (c) => !c.aiOff },

  // ── A title ──
  { id: "text-edit", label: "Edit", targets: ["text"], order: 10 },
  // A callout (ADR 0061) has neither: its label and leader line come in by themselves.
  { id: "particles", label: "Particles", targets: ["text"], order: 20, when: (c) => !c.text?.callout },
  { id: "walk-through", label: "Walk-through", targets: ["text"], order: 30, when: (c) => !c.text?.callout },
  { id: "pin", label: "Pin", targets: ["text"], order: 40 },
  { id: "timing", label: "Timing", targets: ["text"], order: 50 },
  { id: "hook", label: "Hook", targets: ["text"], order: 60, when: carriesHook },
  { id: "guides", label: "Guides", targets: ["text"], order: 70 },

  // ── The music ──
  { id: "music-adjust", label: "Adjust", targets: ["music"], order: 10 },
  { id: "music-replace", label: "Replace", targets: ["music"], order: 20 },
  { id: "music-suggest", label: "Suggestions", targets: ["music"], order: 30, when: (c) => c.instagram },
];

/**
 * Whether a clip is a presenter take: one a script placed (ADR 0060), or a generated take composed with the
 * presenter's kit (its generation record says so). AI b-roll without her is an ordinary clip.
 */
export function isPresenterClip(clipId: string, asset: { isPresenterTake?: boolean } | null | undefined): boolean {
  return clipId.startsWith("script-") || Boolean(asset?.isPresenterTake);
}

/** What a tap on this selection reaches. */
export function targetsFor(selection: { kind: "clip" | "text" | "music" } | null, presenter = false): ControlTarget[] {
  if (!selection) return ["reel"];
  if (selection.kind === "clip") return presenter ? ["presenter", "clip"] : ["clip"];
  return [selection.kind];
}

export type ResolvedControl = { id: string; label: string; ariaLabel?: string; place: "bar" | "more"; owner: string; target: ControlTarget };

/**
 * The controls for these targets, in order: the first target's controls
 * first (the presenter's before the clip's), each list by `order`; one entry
 * per id (an id shared by two targets, like Hook, shows once).
 */
export function controlsFor(targets: readonly ControlTarget[], context: ControlContext, specs: readonly ControlSpec[] = BUILT_IN_CONTROLS): ResolvedControl[] {
  const seen = new Set<string>();
  const out: ResolvedControl[] = [];
  for (const target of targets) {
    const list = specs.filter((spec) => spec.targets.includes(target) && (!spec.when || spec.when(context))).sort((a, b) => a.order - b.order);
    for (const spec of list) {
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      out.push({ id: spec.id, label: typeof spec.label === "function" ? spec.label(context) : spec.label, ...(spec.ariaLabel ? { ariaLabel: spec.ariaLabel } : {}), place: spec.place ?? "bar", owner: spec.owner ?? "editor", target });
    }
  }
  return out;
}
