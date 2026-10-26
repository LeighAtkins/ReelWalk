import { describe, expect, it } from "vitest";
import { applyCommand, COMMAND_TYPES, migrateEndCardReveal, migrateTransition, parseTimeline, RETIRED_TRANSITIONS, TRANSITIONS, type Command, type Timeline } from "../src";

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

describe("saved reels with retired kinds (ADR 0082)", () => {
  it("reads a whip and a speed ramp as a cut, and a fade or over end card as the cut card", () => {
    expect(RETIRED_TRANSITIONS).toEqual(["whip", "speedRamp"]);
    for (const kind of RETIRED_TRANSITIONS) expect(TRANSITIONS as readonly string[]).not.toContain(kind);
    expect(migrateTransition("whip")).toBe("cut");
    expect(migrateTransition("speedRamp")).toBe("cut");
    expect(migrateTransition("focusPull")).toBe("focusPull");
    expect(migrateEndCardReveal("fade")).toBe("cut");
    expect(migrateEndCardReveal("over")).toBe("cut");
    expect(migrateEndCardReveal("leak")).toBe("leak");
    const saved = parseTimeline({
      version: 1,
      clips: [
        { id: "a", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
        { id: "b", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000, transitionIn: "whip", whipDirection: "left" },
        { id: "c", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000, transitionIn: "speedRamp", speedRamp: { peak: 4 } },
        { id: "d", assetId: "x", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000, transitionIn: "fade" },
      ],
      texts: [], music: null,
      endCard: { text: "R", durationMs: 2000, reveal: "fade" },
    });
    expect(saved.clips.map((clip) => clip.transitionIn)).toEqual(["cut", "cut", "cut", "fade"]);
    // The retired settings are not carried on; the pan direction is kept so the document round-trips.
    expect("speedRamp" in saved.clips[2]).toBe(false);
    expect(saved.clips[1].whipDirection).toBe("left");
    expect(saved.endCard?.reveal).toBe("cut");
    // Parsing again changes nothing.
    expect(parseTimeline(saved)).toEqual(saved);
  });

  it("refuses to set a retired transition, so nothing new is stored with one", () => {
    for (const transition of RETIRED_TRANSITIONS) {
      const result = apply(base(), { type: "setTransition", clipId: "b", transition: transition as never });
      expect(result.rejected).toMatch(/retired/);
      expect(result.timeline.clips[1].transitionIn).toBe("cut");
    }
  });
});
