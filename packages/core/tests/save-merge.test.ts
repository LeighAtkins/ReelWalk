import { describe, expect, it } from "vitest";
import { keepSavedTextFields } from "../src/save-merge";
import { clipSchema, emptyTimeline, parseTimeline, textSchema } from "../src/timeline";

const clip = clipSchema.parse({ id: "c1", assetId: "plate", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 });
/** A boxed dark title, as D5 saved it. */
const title = textSchema.parse({ id: "t1", text: "cosy. It's small.", startMs: 500, endMs: 3500, x: 0.5, y: 0.64, style: "box", color: "#111111", size: 1.3, font: "serif", tracking: 0.02 });
const saved = { ...emptyTimeline(), clips: [clip], texts: [title] };

describe("a save keeps the text fields it leaves out", () => {
  it("keeps the saved colour, font and tracking of a boxed dark title sent without them", () => {
    const body = { ...saved, texts: [{ id: "t1", text: "cosy. It's small.", startMs: 500, endMs: 3500, y: 0.66 }] };
    const merged = parseTimeline(keepSavedTextFields(body, saved));
    expect(merged.texts[0]).toMatchObject({ color: "#111111", style: "box", font: "serif", tracking: 0.02, size: 1.3, x: 0.5, y: 0.66 });
    // Without the merge the schema's defaults win: the title turns white and plain.
    expect(parseTimeline(body).texts[0]).toMatchObject({ color: "#ffffff", style: "plain", size: 1 });
  });
  it("clears a field sent as null, so it takes the default again", () => {
    const body = { ...saved, texts: [{ id: "t1", text: "cosy. It's small.", startMs: 500, endMs: 3500, color: null, font: null }] };
    const merged = parseTimeline(keepSavedTextFields(body, saved));
    expect(merged.texts[0].color).toBe("#ffffff");
    expect(merged.texts[0].font).toBeUndefined();
    expect(merged.texts[0]).toMatchObject({ style: "box", size: 1.3 });
  });
  it("leaves a new text, a text sent in full, and a body without texts as they are", () => {
    const fresh = { id: "t2", text: "new", startMs: 0, endMs: 1000 };
    const full = { ...title, color: "#ff0000" };
    const body = { ...saved, texts: [fresh, full] };
    const merged = parseTimeline(keepSavedTextFields(body, saved));
    expect(merged.texts[0]).toMatchObject({ id: "t2", color: "#ffffff" });
    expect(merged.texts[1]).toMatchObject({ id: "t1", color: "#ff0000", font: "serif" });
    expect(keepSavedTextFields(body, null)).toBe(body);
    expect(keepSavedTextFields({ clips: [] }, saved)).toEqual({ clips: [] });
    expect(keepSavedTextFields("not a timeline", saved)).toBe("not a timeline");
  });
});
