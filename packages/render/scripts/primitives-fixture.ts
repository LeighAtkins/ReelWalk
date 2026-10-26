/**
 * The Remotion-primitives comparison reel (ADR 0083): one shot into each transition kind the schema has, an elegant
 * serif title, a single long word that used to run off the frame, a long sentence that wraps, and the price card
 * with a 24-character price (the schema's most). Pure, so the render package's tests can check it without a renderer.
 */
import { framePlan, parseTimeline, type Timeline } from "@reelwalk/core";

export const FPS = 30;
/** Each shot is 2 s from 1 s into its source, so both sides of every cut have footage to spare (the handles). */
const SHOT_MS = 2000;
const SOURCE_START_MS = 1000;
/** The source files, in shot order (any 1080×1920 or 540×960 portrait clips at least 4 s long). */
export const MEDIA = ["s1.mp4", "s2.mp4", "s3.mp4", "s4.mp4", "s5.mp4", "s6.mp4"];

export function primitivesTimeline(): Timeline {
  const transitions = [
    { transitionIn: "fade" as const },
    { transitionIn: "fade" as const },
    { transitionIn: "softDissolve" as const },
    { transitionIn: "focusPull" as const },
    { transitionIn: "lightLeak" as const },
    { transitionIn: "cut" as const },
  ];
  const clips = transitions.map((transition, i) => ({
    id: `c${i + 1}`, assetId: `s${i + 1}`, kind: "VIDEO" as const, sourceStartMs: SOURCE_START_MS, sourceEndMs: SOURCE_START_MS + SHOT_MS, volume: 0, ...transition,
  }));
  return parseTimeline({
    version: 1,
    clips,
    texts: [
      // The opening hook (owner, 2026-10-26): twelve words in sentence case with the price and the suburb, white, unboxed, a
      // soft shadow, in the top 30 % of the frame; the elegant style, which is Playfair Display from ADR 0083.
      { id: "hook", text: HOOK, startMs: 0, endMs: 3600, x: 0.5, y: 0.17, style: "elegant", size: 1.25, color: "#ffffff", shadow: "soft", animation: "auto" },
      // One word, so it never wraps: 1.4 × the frame's width was its limit, so it ran off both edges.
      { id: "long", text: "Extraordinarily-Magnificent", startMs: 4000, endMs: 7600, x: 0.5, y: 0.42, style: "headline", size: 1.5, animation: "none" },
      { id: "wrap", text: "A quiet chalet above the valley with room for everyone", startMs: 8000, endMs: 11600, x: 0.5, y: 0.35, style: "elegant", size: 1.2, animation: "auto" },
    ],
    details: { price: "AUD 12,850,000 or offers", beds: "6", baths: "4", area: "540 m²", address: "14 Alpenrose Weg, Zermatt", contact: "", placement: "end" },
    music: null,
  });
}

/** Twelve words, sentence case, price and suburb. */
export const HOOK = "A six-bedroom alpine lodge in Zermatt, ski-in ski-out, offers over AUD 12.8M";

export type Shot = { frame: number; group: string; why: string };

/** The frames of the sheets: across every cut (−8 to +8, every 2), and each title and the card at rest. */
export function framesToShow(timeline: Timeline): Shot[] {
  const plan = framePlan(timeline, FPS);
  const shots: Shot[] = [];
  for (const [i, entry] of plan.clips.entries()) {
    if (i === 0) {
      for (const d of [0, 2, 4, 6, 8, 10, 12, 14, 16]) shots.push({ frame: d, group: `cut0-${entry.clip.transitionIn}`, why: `opening +${d}` });
      continue;
    }
    for (let d = -8; d <= 8; d += 2) shots.push({ frame: entry.from + d, group: `cut${i}-${entry.clip.transitionIn}${entry.clip.whipDirection ? `-${entry.clip.whipDirection}` : ""}`, why: `cut ${i} ${d >= 0 ? "+" : ""}${d}` });
  }
  for (const text of timeline.texts) shots.push({ frame: Math.round(((text.startMs + text.endMs) / 2) * FPS / 1000), group: "titles", why: text.id });
  shots.push({ frame: plan.totalFrames - 20, group: "titles", why: "card" });
  return shots;
}
