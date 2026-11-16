import { expect, it } from "vitest";
import { timelineSchema, textSchema, physicalTextSchema } from "@reelwalk/core";
import { physicalTextEdit } from "./physical-text-edit";

const timeline = timelineSchema.parse({ version: 1, music: null, clips: [
  { id: "a", assetId: "a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
  { id: "b", assetId: "b", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 },
], texts: [] });
it("new physical title fills its shot rather than disappearing mid-shot", () => {
  expect(physicalTextEdit(timeline, 5500)).toMatchObject({ startMs: 4000, endMs: 12000, animation: "none" });
});
it("conversion removes incompatible bindings but subsequent edits preserve intentional timing", () => {
  const old = textSchema.parse({ id: "t", text: "Pool", startMs: 5000, endMs: 7000, x: .5, y: .5 });
  const converted = physicalTextEdit(timeline, 0, old);
  expect(converted).toMatchObject({ startMs: 4000, endMs: 12000, surface: undefined, pin: undefined, fill: undefined });
  const existing = { ...old, physical3d: physicalTextSchema.parse({}) };
  expect(physicalTextEdit(timeline, 0, existing)).not.toHaveProperty("startMs");
  expect(physicalTextEdit(timeline, 0, existing)).not.toHaveProperty("endMs");
});
it("refuses a title without a containing shot", () => {
  expect(() => physicalTextEdit(timelineSchema.parse({ version: 1, music: null, clips: [], texts: [] }), 0)).toThrow("Add a shot");
});
