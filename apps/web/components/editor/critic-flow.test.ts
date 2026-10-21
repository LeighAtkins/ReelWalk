import { describe, expect, it } from "vitest";
import { critique, fixAllCommand, parseTimeline, type CriticFrame, type TextOverlay, type Timeline } from "@reelwalk/core";
import { createDocumentStore } from "./document-store";

// The critic's fixes as the Export sheet applies them (ADR 0062): through the editor's document,
// each fix one history entry, "Fix all" one entry, undo taking each back whole.

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3250 },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
    ],
    texts: [
      { id: "top", text: "Open Saturday", startMs: 200, endMs: 3000, y: 0.05 },
      { id: "mid", text: "Kitchen", startMs: 3500, endMs: 6000, y: 0.4 },
    ],
    music: { assetId: "song", bpm: 120, beatOffsetMs: 0 },
  });
}
const durations = () => ({ v1: 20000, v2: 20000 });
const titleFont = (text: TextOverlay) => ({ fontSize: 76 * text.size });
const findingsOf = (timeline: Timeline) => critique({ timeline, titleFont, sourceDurationsMs: durations() });

describe("the critic's fixes in the editor's document", () => {
  it("one fix is one undo step", () => {
    const store = createDocumentStore(reel(), durations);
    const before = store.getState().history.present;
    const move = findingsOf(before).find((finding) => finding.id === "safe-zone:top")!;
    const fix = move.fixes[0];
    if (fix.kind !== "command") throw new Error("expected a command");
    const result = store.runCommand(fix.command);
    expect(result.changes).toEqual([{ kind: "text", id: "top" }]);
    expect(store.getState().history.past).toHaveLength(1);
    store.dispatch({ type: "undo" });
    expect(store.getState().history.present).toBe(before);
  });

  it("Fix all lands as one entry and one undo restores the reel exactly", () => {
    const store = createDocumentStore(reel(), durations);
    const before = store.getState().history.present;
    const command = fixAllCommand(findingsOf(before))!;
    const result = store.runCommand(command);
    expect(result.rejected).toBeUndefined();
    expect(result.changes.length).toBeGreaterThan(1);
    expect(store.getState().history.past).toHaveLength(1);
    // The flagged title moved and the cut is on the beat; nothing the critic would still fix safely remains.
    expect(fixAllCommand(findingsOf(store.getState().history.present))).toBeNull();
    store.dispatch({ type: "undo" });
    expect(store.getState().history.present).toBe(before);
  });

  it("findings keep their ids across an unrelated edit, so the list does not jump", () => {
    const store = createDocumentStore(reel(), durations);
    const frames = new Map<string, CriticFrame>();
    const first = findingsOf(store.getState().history.present).map((finding) => finding.id);
    store.runCommand({ type: "updateText", textId: "mid", patch: { color: "#ffd23f" } });
    const after = critique({ timeline: store.getState().history.present, titleFont, frames, sourceDurationsMs: durations() }).map((finding) => finding.id);
    expect(after).toEqual(first);
  });
});
