import { clipDurationMs, clipStartsMs, hookSchema, textSchema, type Hook, type HookKind, type Timeline } from "./timeline";

/**
 * Visual hooks (ADR 0041): the first two seconds that stop the scroll,
 * built from the reel's own footage. Three are drawn by the composition
 * (`timeline.hook`); "words behind" is a preset that writes ordinary
 * texts, so it stays editable like any title.
 */

export const HOOK_LABELS: Record<HookKind | "words-behind", string> = {
  alert: "System alert", spotlight: "Colour spotlight", device: "Inside the phone", "words-behind": "Words behind the person",
};
export const HOOK_DESCRIPTIONS: Record<HookKind | "words-behind", string> = {
  alert: "A phone-style alert pops over the first shot with your line on it, then the reel plays.",
  spotlight: "A flat colour field with only the person cut out of the first shot; the colour irises away to the room.",
  device: "The reel starts inside a phone on a dark field and the phone grows until its screen is the whole frame.",
  "words-behind": "Three big words appear one by one behind the person in the first shot, who walks in front of them.",
};
export const HOOK_FONT_FAMILIES: Record<Hook["font"], string> = {
  sans: "'Archivo', 'Helvetica Neue', Arial, sans-serif",
  serif: "'Cormorant Garamond', 'Cormorant', Georgia, serif",
};

export function setHook(timeline: Timeline, hook: Hook | null): Timeline {
  return { ...timeline, hook: hook ? hookSchema.parse(hook) : null };
}

/**
 * "Words behind the person": up to three words staggered over the first
 * shot, each behind the people in it, extruded, held to the end of the
 * shot (or 3 s). Existing hook texts are replaced.
 */
export function wordsBehindHook(timeline: Timeline, words: string[], options: { color?: string; font?: "serif" | "sans" | "editorial" } = {}): Timeline {
  const first = timeline.clips[0];
  if (!first) return timeline;
  const clean = words.map((w) => w.trim()).filter(Boolean).slice(0, 3);
  if (!clean.length) return timeline;
  const endMs = Math.min(clipStartsMs(timeline)[0] + clipDurationMs(first), 3200);
  const step = Math.min(500, Math.max(250, Math.floor((endMs - 600) / clean.length)));
  const texts = timeline.texts.filter((t) => !t.id.startsWith("hook-word-"));
  clean.forEach((word, i) => {
    const startMs = i * step;
    if (endMs - startMs < 400) return;
    texts.push(textSchema.parse({
      id: `hook-word-${i + 1}`, text: word, startMs, endMs, x: 0.5, y: 0.28 + i * 0.17,
      style: "headline", color: options.color ?? "#ffffff", size: 1.9, animation: "pop", font: options.font ?? "sans",
      behind: true, depth: "extruded",
    }));
  });
  return { ...timeline, texts };
}
