import type { Timeline } from "./timeline";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A save keeps the saved values of the text fields it leaves out. A whole
 * timeline arrives at `/api/reels/:id/save`, and the schema fills every
 * omitted field with its default: a boxed dark title saved without `color`
 * came back white (D5, 2026-10-23). The editor always sends full texts, so
 * for it this changes nothing; an agent that rebuilds a text from a shorter
 * copy keeps what it did not mention. An explicit `null` still clears the
 * field, so it takes the default again (no field of a text may be null).
 * Texts are matched by id; a new text is left as sent. Pure, over the raw
 * body, before the schema is applied.
 */
export function keepSavedTextFields(incoming: unknown, saved: Pick<Timeline, "texts"> | null | undefined): unknown {
  if (!saved || !isRecord(incoming) || !Array.isArray(incoming.texts)) return incoming;
  const before = new Map(saved.texts.map((text) => [text.id, text]));
  const texts = incoming.texts.map((text) => {
    if (!isRecord(text) || typeof text.id !== "string") return text;
    const kept = before.get(text.id);
    const merged: Record<string, unknown> = kept ? { ...kept } : {};
    for (const [key, value] of Object.entries(text)) {
      if (value === undefined) continue;
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  });
  return { ...incoming, texts };
}
