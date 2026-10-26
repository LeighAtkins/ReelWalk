import { describe, expect, it } from "vitest";
import { applyCommand, COMMAND_TYPES, parseTimeline, type Command, type Timeline } from "../src";

/** The Remotion toolbox's kinds (ADR 0082) through the commands an agent sends over HTTP or the MCP connector. */
const base = (): Timeline =>
  parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
      { id: "b", assetId: "x", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 4000 },
    ],
    texts: [{ id: "hook", text: "Live above it all", startMs: 0, endMs: 2000, style: "elegant" }],
    music: null,
  });
const apply = (timeline: Timeline, command: Command) => applyCommand(timeline, command, { generation: 1 });

describe("toolbox kinds through commands", () => {
  it("sets the new transitions and title reveals", () => {
    for (const transition of ["softDissolve", "focusPull", "lightLeak"] as const) {
      const result = apply(base(), { type: "setTransition", clipId: "b", transition });
      expect(result.rejected).toBeUndefined();
      expect(result.timeline.clips[1].transitionIn).toBe(transition);
    }
    for (const animation of ["fadeQuick", "maskUp", "trackIn", "blurIn"] as const) {
      const result = apply(base(), { type: "updateText", textId: "hook", patch: { animation } });
      expect(result.rejected).toBeUndefined();
      expect(result.timeline.texts[0].animation).toBe(animation);
    }
  });

  it("setEndCard adds, changes and removes the card, and refuses a bad one", () => {
    expect(COMMAND_TYPES).toContain("setEndCard");
    const added = apply(base(), { type: "setEndCard", endCard: { text: "ReelWalk Realty", durationMs: 2000, reveal: "leak" } });
    expect(added.timeline.endCard).toEqual({ text: "ReelWalk Realty", durationMs: 2000, reveal: "leak" });
    // Nothing is retimed: the card is drawn over the end.
    expect(added.timeline.clips).toEqual(base().clips);
    const removed = apply(added.timeline, { type: "setEndCard", endCard: null });
    expect(removed.timeline.endCard).toBeUndefined();
    const bad = apply(base(), { type: "setEndCard", endCard: { text: "R", durationMs: 2000, reveal: "bounce" as never } });
    expect(bad.rejected).toMatch(/not valid/);
    expect(bad.timeline.endCard).toBeUndefined();
  });
});
