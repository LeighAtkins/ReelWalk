/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  mediaAsset: { findMany: vi.fn() },
  reel: { create: vi.fn(), deleteMany: vi.fn() },
}));
const thread = vi.hoisted(() => ({ notesAvailable: vi.fn(() => true), startNote: vi.fn() }));

vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("./ai-gate", () => ({ aiIsOff: async () => false, assertAiOn: async () => undefined, AI_OFF_CODE: "ai_off", AI_OFF_MESSAGE: "off" }));
vi.mock("./ai-edit", () => ({ aiAvailabilityReason: async () => null }));
vi.mock("./library", () => ({ toLibraryAssets: async (rows: unknown[]) => rows }));
vi.mock("./reel-thread", () => thread);

import { TOOLS } from "./mcp/tools";
import { CREATE_ANGLES, createBrief, startCreate, titleFor } from "./create-reels";
import { CREATE_MAX_CALLS, CREATE_TOOLS, checkCall, noteToolSpecs, splitCaption } from "./reel-notes";

const user = { id: "u1", workspaceId: "w1" } as any;
const photo = { id: "m1", kind: "IMAGE", durationMs: null, isPano: false, spot: null, room: null, fileName: "front.jpg" };
const video = { id: "m2", kind: "VIDEO", durationMs: 4000, isPano: false, spot: null, room: null, fileName: "walk.mp4" };

describe("what a create run can reach", () => {
  it("adds stock search and add_media to the note's reading tools, and still nothing that spends or exports", () => {
    const names = noteToolSpecs(TOOLS, "create").map((spec) => spec.name);
    expect(names).toEqual([...CREATE_TOOLS]);
    for (const banned of ["generate_ai_shot", "get_ai_shot", "export_reel", "get_export", "create_reel"]) expect(names).not.toContain(banned);
  });

  it("binds add_media to its reel and to stock or library", () => {
    const state = { reelId: "r1", exportIds: new Set<string>(), dryRuns: new Set<string>(), calls: 0, mode: "create" as const };
    expect(checkCall(state, "search_stock", { query: "beach house dusk" })).toMatchObject({ ok: true });
    expect(checkCall(state, "add_media", { mode: "stock", stockIds: [1], reelId: "r2" })).toMatchObject({ ok: false });
    expect(checkCall(state, "add_media", { mode: "stock", stockIds: [1] })).toEqual({ ok: true, args: { mode: "stock", stockIds: [1], reelId: "r1" } });
    expect(checkCall(state, "add_media", { mode: "prepare_upload", fileName: "x.mp4" })).toMatchObject({ ok: false });
    expect(checkCall(state, "generate_ai_shot", { prompt: "a pool at dusk" })).toMatchObject({ ok: false });
    expect(checkCall(state, "export_reel", { reelId: "r1" })).toMatchObject({ ok: false });
    expect(checkCall({ ...state, calls: CREATE_MAX_CALLS }, "get_reel", {})).toMatchObject({ ok: false });
  });

  it("keeps a note's own list in note mode", () => {
    const state = { reelId: "r1", exportIds: new Set<string>(), dryRuns: new Set<string>(), calls: 0 };
    expect(checkCall(state, "search_stock", { query: "pool" })).toMatchObject({ ok: false });
    expect(checkCall(state, "add_media", { mode: "stock", stockIds: [1] })).toMatchObject({ ok: false });
  });
});

describe("the caption a create run ends with", () => {
  it("is split from the reply", () => {
    expect(splitCaption("Five shots of the garden, cut to the beat.\nCaption: Sunday in the garden. #home #garden")).toEqual({ reply: "Five shots of the garden, cut to the beat.", caption: "Sunday in the garden. #home #garden" });
  });

  it("keeps a caption that runs over lines, and answers null without one", () => {
    expect(splitCaption("Done.\ncaption: Line one\n#a #b").caption).toBe("Line one\n#a #b");
    expect(splitCaption("Nothing to say about captions here.")).toEqual({ reply: "Nothing to say about captions here.", caption: null });
  });
});

describe("the brief and title of an option", () => {
  it("quotes the idea and names the angle, the footage and the captions choice", () => {
    const brief = createBrief({ idea: "Just listed in Fitzroy", angle: CREATE_ANGLES[1], captions: false, reelId: "r1", title: "t", revision: 0, uploads: 0 });
    expect(brief).toContain('"""\nJust listed in Fitzroy\n"""');
    expect(brief).toContain("Mini story");
    expect(brief).toContain("gave no footage");
    expect(brief).toContain("Captions: off");
  });

  it("titles from the idea's first words", () => {
    expect(titleFor("Five reasons buyers love living near the beach", CREATE_ANGLES[2])).toBe("Five reasons buyers love living near · Three reasons");
  });
});

describe("startCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    thread.notesAvailable.mockReturnValue(true);
    let n = 0;
    db.reel.create.mockImplementation(async ({ data }: any) => ({ id: `r${++n}`, revision: 0, data }));
    db.mediaAsset.findMany.mockResolvedValue([photo, video]);
    thread.startNote.mockImplementation(async (input: any) => ({ ok: true, noteId: `n-${input.reelId}`, jobId: "j", settled: Promise.resolve() }));
  });

  it("makes one reel per angle with the uploads on each, under fresh clip ids, and starts a create run on each", async () => {
    const started = await startCreate({ user, idea: "Just listed: a cottage with a garden", mediaIds: ["m1", "m2"], options: 3, captions: true, origin: "https://x" });
    expect(started).toMatchObject({ ok: true, skipped: 0 });
    if (!started.ok) return;
    expect(started.options.map((option) => option.angle)).toEqual(CREATE_ANGLES.map((angle) => angle.label));
    const timelines = db.reel.create.mock.calls.map(([arg]: any) => arg.data.timeline);
    for (const timeline of timelines) expect(timeline.clips.map((clip: any) => clip.assetId)).toEqual(["m1", "m2"]);
    const ids = timelines.flatMap((timeline: any) => timeline.clips.map((clip: any) => clip.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const [input] of thread.startNote.mock.calls as any[]) {
      expect(input.note).toBe("Just listed: a cottage with a garden");
      expect(input.create.brief).toContain("already on the reel");
    }
  });

  it("refuses media that is not in the workspace, or music", async () => {
    db.mediaAsset.findMany.mockResolvedValue([photo]);
    expect(await startCreate({ user, idea: "Just listed: a cottage with a garden", mediaIds: ["m1", "m9"], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 400 });
    db.mediaAsset.findMany.mockResolvedValue([{ ...photo, kind: "AUDIO" }]);
    expect(await startCreate({ user, idea: "Just listed: a cottage with a garden", mediaIds: ["m1"], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 400 });
    expect(db.reel.create).not.toHaveBeenCalled();
  });

  it("stops at the first option that cannot start, removes its empty reel and says how many were skipped", async () => {
    thread.startNote
      .mockImplementationOnce(async (input: any) => ({ ok: true, noteId: `n-${input.reelId}`, jobId: "j", settled: Promise.resolve() }))
      .mockImplementationOnce(async () => ({ ok: false, status: 403, message: "This month's AI requests are used." }));
    const started = await startCreate({ user, idea: "Five reasons to live by the beach", mediaIds: [], options: 3, captions: true, origin: "https://x" });
    expect(started).toMatchObject({ ok: true, skipped: 2, message: "This month's AI requests are used." });
    expect(db.reel.deleteMany).toHaveBeenCalledWith({ where: { id: "r2", workspaceId: "w1" } });
  });

  it("refuses an idea too short to work from, and when Claude is not set up", async () => {
    expect(await startCreate({ user, idea: "house", mediaIds: [], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 400 });
    thread.notesAvailable.mockReturnValue(false);
    expect(await startCreate({ user, idea: "Five reasons to live by the beach", mediaIds: [], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 503 });
  });
});
