/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  mediaAsset: { findMany: vi.fn() },
  reel: { create: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn() },
  workflowRun: { findUnique: vi.fn(), create: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
}));
const thread = vi.hoisted(() => ({ notesAvailable: vi.fn(() => true), startNote: vi.fn() }));

vi.mock("@reelwalk/db", () => ({ prisma: db }));
vi.mock("./ai-gate", () => ({ aiIsOff: async () => false, assertAiOn: async () => undefined, AI_OFF_CODE: "ai_off", AI_OFF_MESSAGE: "off" }));
vi.mock("./ai-edit", () => ({ aiAvailabilityReason: async () => null }));
vi.mock("./library", () => ({ toLibraryAssets: async (rows: unknown[]) => rows }));
vi.mock("./reel-thread", () => thread);

import { TOOLS } from "./mcp/tools";
import { CREATE_ANGLES, createBrief, createOptionIds, startCreate, titleFor } from "./create-reels";
import { CREATE_MAX_CALLS, CREATE_TOOLS, checkCall, describeToolSave, noteToolSpecs, runNote, savedRevision, splitCaption } from "./reel-notes";
import type { ToolResult, ToolSpec } from "./mcp/tools";
import type { ToolTurn } from "./openai";

const user = { id: "u1", workspaceId: "w1" } as any;
const RID = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
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

describe("saves made by add_media and add_voiceover", () => {
  it("read the revision each saved, and describe themselves for the record", () => {
    expect(savedRevision("add_media", { addedToReel: { revision: 7 } })).toBe(7);
    expect(savedRevision("add_media", { addedToReel: null })).toBeNull();
    expect(savedRevision("add_voiceover", { revision: 9 })).toBe(9);
    expect(describeToolSave("add_media", { mode: "stock", stockIds: [1, 2] })).toBe("add_media stock 2 item(s)");
    expect(describeToolSave("add_voiceover", { voice: "aura-2:theia", script: "Hi there." })).toBe('add_voiceover aura-2:theia "Hi there."');
  });

  it("move the version a create run exports to the last revision saved, whichever tool saved it", async () => {
    const okText = (data: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }] });
    const tools = noteToolSpecs(TOOLS, "create").map((spec): ToolSpec => ({
      ...spec,
      limits: undefined,
      async run(_ctx, args) {
        if (spec.name === "add_media") return okText({ assets: [], addedToReel: { reelId: args.reelId, revision: 4, clipIds: ["c1"] } });
        if (spec.name === "add_voiceover") return okText({ revision: 5 });
        return okText({ revision: 3 });
      },
    }));
    const plan: ToolTurn[] = [
      { content: [{ type: "tool_use", id: "t1", name: "add_media", input: { mode: "stock", stockIds: [1] } }], stopReason: "tool_use", usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }, model: "m" },
      { content: [{ type: "tool_use", id: "t2", name: "add_voiceover", input: { script: "Hi there.", voice: "aura-2:theia" } }], stopReason: "tool_use", usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }, model: "m" },
      { content: [{ type: "text", text: "Done.\nCaption: Hi" }], stopReason: "end_turn", usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }, model: "m" },
    ];
    let n = 0;
    const applying: string[][] = [];
    const outcome = await runNote(
      { user, reelId: "r1", note: "idea", origin: "https://x", brief: "b", exportIds: [], revision: 3, mode: "create", onApplying: (lines) => applying.push(lines) },
      { turn: async () => plan[n++], gate: async () => true, tools },
    );
    expect(outcome).toMatchObject({ changed: true, revisionBefore: 3, revisionAfter: 5 });
    expect(outcome.applied).toEqual(["add_media stock 1 item(s)", 'add_voiceover aura-2:theia "Hi there."']);
    expect(applying).toEqual([["add_media stock 1 item(s)"], ['add_voiceover aura-2:theia "Hi there."']]);
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
    expect(brief).toContain("Voiceover: none.");
    const voiced = createBrief({ idea: "Just listed in Fitzroy", angle: CREATE_ANGLES[0], captions: true, reelId: "r1", title: "t", revision: 0, uploads: 0, voice: "aura-2:theia" });
    expect(voiced).toContain("Voiceover: yes, in Theia (voice aura-2:theia)");
    expect(voiced).toContain("add_voiceover");
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
    db.workflowRun.findUnique.mockResolvedValue(null);
    db.workflowRun.create.mockImplementation(async ({ data }: any) => ({ id: "run1", requestHash: data.requestHash }));
    thread.startNote.mockImplementation(async (input: any) => ({ ok: true, noteId: `n-${input.reelId}`, jobId: "j", settled: Promise.resolve() }));
  });

  it("makes one reel per angle with the uploads on each, under fresh clip ids, and starts a create run on each", async () => {
    const started = await startCreate({ user, requestId: RID, idea: "Just listed: a cottage with a garden", mediaIds: ["m1", "m2"], options: 3, captions: true, origin: "https://x" });
    expect(started).toMatchObject({ ok: true, skipped: 0 });
    if (!started.ok) return;
    expect(started.options.map((option) => option.angle)).toEqual(CREATE_ANGLES.map((angle) => angle.label));
    const timelines = db.reel.create.mock.calls.map(([arg]: any) => arg.data.timeline);
    for (const timeline of timelines) expect(timeline.clips.map((clip: any) => clip.assetId)).toEqual(["m1", "m2"]);
    const ids = timelines.flatMap((timeline: any) => timeline.clips.map((clip: any) => clip.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, [input]] of (thread.startNote.mock.calls as any[]).entries()) {
      expect(input.note).toBe("Just listed: a cottage with a garden");
      expect(input.create.brief).toContain("already on the reel");
      // Ids derived from the request, so a retry finds them again.
      expect(input.requestId).toBe(createOptionIds("w1", RID, index).noteRequestId);
      expect(db.reel.create.mock.calls[index][0].data.id).toBe(createOptionIds("w1", RID, index).reelId);
    }
  });

  it("refuses media that is not in the workspace, or music", async () => {
    db.mediaAsset.findMany.mockResolvedValue([photo]);
    expect(await startCreate({ user, requestId: RID, idea: "Just listed: a cottage with a garden", mediaIds: ["m1", "m9"], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 400 });
    db.mediaAsset.findMany.mockResolvedValue([{ ...photo, kind: "AUDIO" }]);
    expect(await startCreate({ user, requestId: RID, idea: "Just listed: a cottage with a garden", mediaIds: ["m1"], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 400 });
    expect(db.reel.create).not.toHaveBeenCalled();
  });

  it("stops at the first option that cannot start, removes its empty reel and says how many were skipped", async () => {
    thread.startNote
      .mockImplementationOnce(async (input: any) => ({ ok: true, noteId: `n-${input.reelId}`, jobId: "j", settled: Promise.resolve() }))
      .mockImplementationOnce(async () => ({ ok: false, status: 403, message: "This month's AI requests are used." }));
    const started = await startCreate({ user, requestId: RID, idea: "Five reasons to live by the beach", mediaIds: [], options: 3, captions: true, origin: "https://x" });
    expect(started).toMatchObject({ ok: true, skipped: 2, message: "This month's AI requests are used." });
    // Only a reel no note was ever started on is removed.
    expect(db.reel.deleteMany).toHaveBeenCalledWith({ where: { id: "r2", workspaceId: "w1", aiEdits: { none: {} } } });
  });

  it("asks for the voice only where the server can speak, and refuses a voice not offered", async () => {
    vi.stubEnv("VOICE_ENABLED", "true");
    await startCreate({ user, requestId: RID, idea: "Five reasons to live by the beach", mediaIds: [], options: 1, captions: true, origin: "https://x", voice: "aura-2:hyperion" });
    expect((thread.startNote.mock.calls[0][0] as any).create.brief).toContain("aura-2:hyperion");
    vi.stubEnv("VOICE_ENABLED", "false");
    await startCreate({ user, requestId: RID, idea: "Five reasons to live by the beach", mediaIds: [], options: 1, captions: true, origin: "https://x", voice: "aura-2:hyperion" });
    expect((thread.startNote.mock.calls[1][0] as any).create.brief).toContain("Voiceover: none.");
    expect(await startCreate({ user, requestId: RID, idea: "Five reasons to live by the beach", mediaIds: [], options: 1, captions: true, origin: "https://x", voice: "aura-2:nobody" })).toMatchObject({ ok: false, status: 400 });
    vi.unstubAllEnvs();
  });

  it("refuses a request without a request id", async () => {
    expect(await startCreate({ user, requestId: "", idea: "Five reasons to live by the beach", mediaIds: [], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 400 });
    expect(db.reel.create).not.toHaveBeenCalled();
  });

  it("refuses an idea too short to work from, and when Claude is not set up", async () => {
    expect(await startCreate({ user, requestId: RID, idea: "house", mediaIds: [], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 400 });
    thread.notesAvailable.mockReturnValue(false);
    expect(await startCreate({ user, requestId: RID, idea: "Five reasons to live by the beach", mediaIds: [], options: 1, captions: true, origin: "https://x" })).toMatchObject({ ok: false, status: 503 });
  });
});
