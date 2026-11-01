import { describe, expect, it } from "vitest";
import {
  applyCommand,
  boardColumnStarts,
  boardFrame,
  boardPanelAt,
  boardPanelEntryOpacity,
  boardPanelRects,
  boardSchema,
  emptyTimeline,
  parseReelExportPayload,
  referencedAssetIds,
  timelineSchema,
  type Timeline,
} from "../src";

const panel = (id: string, assetId = "take", title?: { lead?: string; keyword: string; effect?: "dotHop"; side?: "left" | "right" }) => ({ id, label: id, assetId, ...(title ? { title } : {}) });
// The reference's board: 4 × 4, starting 1.8 s in, columns sliding in at 3.45, 5.3 and 7.3 s, the outro at 9.73 s.
const reference = () =>
  boardSchema.parse({
    startMs: 1800,
    endMs: 13770,
    rows: 4,
    columns: 4,
    panels: Array.from({ length: 16 }, (_, i) => panel(`p${i}`, "take", { lead: "try this", keyword: `fx${i}`, effect: "dotHop", side: i < 4 ? "left" : "right" })),
    columnAtMs: [3450, 5300, 7300],
    outro: { atMs: 9730, handle: "@reelwalking" },
  });

function reelOf(durationMs: number): Timeline {
  return timelineSchema.parse({
    ...emptyTimeline(),
    clips: [{ id: "c1", assetId: "take", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: durationMs }],
  });
}

describe("a board (ADR 0106)", () => {
  it("fills in the reference's look: an off-white board, white lead, yellow keyword, rounded panels", () => {
    const board = reference();
    expect(board).toMatchObject({ background: "#f8f6f1", textColor: "#ffffff", keywordColor: "#f2df3a", slideMs: 220, entryMs: 250, radius: 22 });
    expect(board.outro).toMatchObject({ glyph: "instagram", dimTo: 0.25 });
    expect(board.panels[0]).toMatchObject({ focusX: 0.5, zoom: 1, mirror: false, sourceStartMs: 0 });
  });

  it("refuses what cannot be drawn: too many panels, repeated ids, column times out of order, an outro off the board", () => {
    const base = { startMs: 0, endMs: 4000, rows: 2, columns: 2, panels: [panel("a"), panel("b")] };
    expect(boardSchema.safeParse({ ...base, panels: [panel("a"), panel("b"), panel("c"), panel("d"), panel("e")] }).success).toBe(false);
    expect(boardSchema.safeParse({ ...base, panels: [panel("a"), panel("a")] }).success).toBe(false);
    expect(boardSchema.safeParse({ ...base, columnAtMs: [100] }).success).toBe(false); // inside the entry
    expect(boardSchema.safeParse({ ...base, columnAtMs: [2000, 3000] }).success).toBe(false); // one too many
    expect(boardSchema.safeParse({ ...base, outro: { atMs: 5000, handle: "@x" } }).success).toBe(false);
    expect(boardSchema.safeParse({ ...base, endMs: 0 }).success).toBe(false);
    expect(boardSchema.safeParse({ ...base, columnAtMs: [2000] }).success).toBe(true);
  });

  it("keeps panels column by column, top to bottom", () => {
    const board = reference();
    expect(boardPanelAt(board, 0, 0)?.id).toBe("p0");
    expect(boardPanelAt(board, 0, 3)?.id).toBe("p3");
    expect(boardPanelAt(board, 1, 0)?.id).toBe("p4");
    expect(boardPanelAt(board, 3, 3)?.id).toBe("p15");
    expect(boardPanelAt({ ...board, panels: board.panels.slice(0, 5) }, 1, 1)).toBeNull();
  });

  it("starts each column at its time, or in equal shares", () => {
    expect(boardColumnStarts(reference())).toEqual([1800, 3450, 5300, 7300]);
    const even = boardSchema.parse({ startMs: 0, endMs: 4000, rows: 1, columns: 4, panels: [panel("a")] });
    expect(boardColumnStarts(even)).toEqual([0, 1000, 2000, 3000]);
  });

  it("lays four panels as the reference does: 0.925 of the width, between 8.4% and 90.6% of the height", () => {
    const rects = boardPanelRects(4, 1080, 1920);
    expect(rects).toHaveLength(4);
    expect(rects[0].width).toBeCloseTo(999, 0);
    expect(rects[0].left).toBeCloseTo(40.5, 1);
    expect(rects[0].top).toBeCloseTo(161.3, 0);
    expect(rects[3].top + rects[3].height).toBeCloseTo(1739.5, 0);
    expect(rects[0].width / rects[0].height).toBeGreaterThan(2.6); // a wide strip, about 2.7:1
    expect(rects[1].top - (rects[0].top + rects[0].height)).toBeCloseTo(71.6, 0);
    // One row is never taller than 16:9.
    const [one] = boardPanelRects(1, 1080, 1920);
    expect(one.height).toBeCloseTo((one.width * 9) / 16, 3);
  });

  it("slides one column at a time, eased, and shrinks the opening frame into the first panel", () => {
    const board = reference();
    expect(boardFrame(board, 1800)).toMatchObject({ scroll: 0, entry: 0, backdrop: 0, brightness: 1 });
    expect(boardFrame(board, 2050).entry).toBe(1);
    expect(boardFrame(board, 3000).scroll).toBe(0);
    expect(boardFrame(board, 3450 + 110).scroll).toBeCloseTo(0.5, 5); // halfway through the first slide
    expect(boardFrame(board, 3450 + 220).scroll).toBe(1);
    expect(boardFrame(board, 6000).scroll).toBe(2);
    expect(boardFrame(board, 9000).scroll).toBe(3);
  });

  it("fades the first column's other panels in, staggered, while the first panel lands", () => {
    const board = reference();
    expect(boardPanelEntryOpacity(board, 0, 0, 1800)).toBe(1);
    expect(boardPanelEntryOpacity(board, 0, 1, 1800)).toBe(0);
    expect(boardPanelEntryOpacity(board, 0, 1, 2200)).toBeGreaterThan(0.9);
    expect(boardPanelEntryOpacity(board, 0, 3, 2000)).toBeLessThan(boardPanelEntryOpacity(board, 0, 1, 2000));
    expect(boardPanelEntryOpacity(board, 1, 2, 1800)).toBe(1);
  });

  it("dims under the outro, pops the glyph past full size and back, then fades the handle up", () => {
    const board = reference();
    expect(boardFrame(board, 9700)).toMatchObject({ brightness: 1, glyph: 0, handle: 0 });
    expect(boardFrame(board, 9730 + 300).brightness).toBeCloseTo(0.25, 5);
    expect(boardFrame(board, 9730 + 210).glyph).toBeCloseTo(1.12, 5);
    expect(boardFrame(board, 9730 + 350).glyph).toBeCloseTo(1, 5);
    expect(boardFrame(board, 9730 + 200).handle).toBe(0);
    expect(boardFrame(board, 9730 + 550).handle).toBeCloseTo(1, 5);
    expect(boardFrame({ ...board, outro: { ...board.outro!, glyph: "none" } }, 10500).glyph).toBe(0);
  });

  it("is set and taken off with one command, inside the reel, and its footage goes into the export", () => {
    const timeline = reelOf(14000);
    const withBoard = applyCommand(timeline, { type: "setBoard", board: { ...reference(), panels: [...reference().panels.slice(0, 15), panel("p15", "other")] } }, { generation: 0 }).timeline;
    expect(withBoard.board?.panels).toHaveLength(16);
    expect(referencedAssetIds(withBoard).sort()).toEqual(["other", "take"]);
    expect(applyCommand(reelOf(9000), { type: "setBoard", board: reference() }, { generation: 0 }).rejected).toMatch(/after the reel/);
    expect(applyCommand(timeline, { type: "setBoard", board: { ...reference(), rows: 9 } as never }, { generation: 0 }).rejected).toMatch(/not valid/);
    expect(applyCommand(withBoard, { type: "setBoard", board: null }, { generation: 0 }).timeline.board).toBeUndefined();
    // A saved reel with a board survives the export payload's round trip.
    const payload = { timeline: withBoard, output: { width: 1080, watermark: false }, assets: { take: { objectKey: "a", kind: "VIDEO" }, other: { objectKey: "b", kind: "VIDEO" } } };
    expect(parseReelExportPayload(JSON.parse(JSON.stringify(payload))).timeline.board?.columnAtMs).toEqual([3450, 5300, 7300]);
  });
});
