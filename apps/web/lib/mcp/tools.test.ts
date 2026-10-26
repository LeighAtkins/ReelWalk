/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { COMMAND_TYPES, emptyTimeline, addClips, type Timeline } from "@reelwalk/core";
import { clipForAsset } from "./clips";
import { SERVER_INSTRUCTIONS, STYLE_HINTS, TOOLS, runTool, type ToolContext, type ToolSpec } from "./tools";
import type { Scope } from "./scopes";

const m = vi.hoisted(() => {
  const fn = () => vi.fn<(...args: any[]) => any>();
  return {
    prisma: {
      reel: { count: fn(), findMany: fn(), findFirst: fn(), create: fn() },
      mediaAsset: { findMany: fn() },
      renderJob: { findFirst: fn() },
      aiGeneration: { findFirst: fn() },
      workspace: { findUnique: fn(), findMany: fn() },
      workspaceMember: { findMany: fn() },
    },
    loadReel: fn(),
    applyReelCommand: fn(),
    saveReelFor: fn(),
    queueReelExport: fn(),
    outputUrls: fn(),
    verify: { ffmpegAvailable: fn(), exportTimeline: fn(), parseTimes: fn(), parseWidth: fn(), framesAt: fn(), contactSheet: fn(), ensureChecks: fn(), withAudio: fn(), audioProblemsFrom: fn(), gateFor: fn() },
    reelAudioTrace: fn(),
    stock: { isStockConfigured: fn(), searchStockClips: fn(), checkStockClips: fn(), importStockClips: fn() },
    actions: { createUpload: fn(), confirmUpload: fn() },
    ai: { aiVideoConfigured: fn(), createAiGeneration: fn(), getAiBalance: fn() },
    ensureWorkerRunning: fn(),
  };
});

vi.mock("@reelwalk/db", () => ({ prisma: m.prisma }));
vi.mock("../reel-command", () => ({ loadReel: m.loadReel, applyReelCommand: m.applyReelCommand, hookInputsFromLibrary: () => ({ sourceDurationsMs: {} }) }));
vi.mock("../save-reel", () => ({ saveReelFor: m.saveReelFor }));
vi.mock("../export-reel", () => ({ queueReelExport: m.queueReelExport }));
vi.mock("../render-jobs", () => ({ outputUrls: m.outputUrls }));
vi.mock("../render-verify", () => ({ ...m.verify, VERIFY: { maxTimes: 12 } }));
vi.mock("../sound", () => ({ reelAudioTrace: m.reelAudioTrace }));
vi.mock("../stock", () => ({ isStockConfigured: m.stock.isStockConfigured, searchStockClips: m.stock.searchStockClips }));
vi.mock("../stock-check", () => ({ checkStockClips: m.stock.checkStockClips }));
vi.mock("../stock-import", () => ({ importStockClips: m.stock.importStockClips }));
vi.mock("@/app/actions", () => m.actions);
vi.mock("../ai-video", () => m.ai);
vi.mock("../render-capacity", () => ({ ensureWorkerRunning: m.ensureWorkerRunning }));
vi.mock("../reels", async () => ({ readTimeline: (await import("@reelwalk/core")).parseTimeline }));
vi.mock("../library", () => ({
  toLibraryAssets: async (rows: any[]) => rows.map((row) => ({ id: row.id, kind: row.kind, fileName: row.fileName, durationMs: row.durationMs ?? null, width: row.width ?? null, height: row.height ?? null, isPano: false, spot: null, room: row.room ?? null, bpm: null, transcript: null, credit: null })),
}));

const ALL: Scope[] = ["reels:read", "reels:write", "exports", "ai:generate"];
const ctxWith = (scopes: Scope[] = ALL): ToolContext => ({ user: { id: "u1", workspaceId: "ws1", email: "a@example.com" } as any, scopes, origin: "https://reelwalking.com" });
const tool = (name: string): ToolSpec => TOOLS.find((spec) => spec.name === name)!;
const allowAll = async () => true;
const run = async (name: string, args: Record<string, unknown> = {}, ctx = ctxWith()) => {
  const spec = tool(name);
  const parsed = z.object(spec.input).parse(args);
  const result = await runTool(spec, ctx, parsed, allowAll);
  const first = result.content[0];
  return { result, data: first.type === "text" ? JSON.parse(first.text) : null };
};

const video = { id: "a1", kind: "VIDEO" as const, durationMs: 4000, isPano: false, spot: null, room: "pool" };
const timelineOf = (...assets: (typeof video)[]): Timeline => addClips(emptyTimeline(), assets.map((asset, index) => clipForAsset(asset, () => `c${index + 1}`)));
const loaded = (timeline = timelineOf(video), revision = 3) => ({ id: "r1", title: "Villa", revision, timeline, library: { a1: { id: "a1", kind: "VIDEO", fileName: "pool.mp4", durationMs: 4000, width: 1080, height: 1920, room: "pool", transcript: null, credit: null } } });

beforeEach(() => {
  vi.clearAllMocks();
  m.prisma.workspace.findUnique.mockResolvedValue({ aiGeneration: "on" });
});

describe("the tool list", () => {
  it("has every tool the connector promises, with unique snake_case names", () => {
    const names = TOOLS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const wanted of ["list_reels", "get_reel", "create_reel", "search_stock", "add_media", "apply_commands", "get_frames", "get_checks", "get_audio_trace", "export_reel", "get_export"]) expect(names).toContain(wanted);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("has no tool that posts or schedules", () => {
    for (const spec of TOOLS) expect(`${spec.name} ${spec.title}`).not.toMatch(/post|schedule|publish|instagram/i);
  });

  it("describes each tool for a model and turns each input into a JSON schema object", () => {
    for (const spec of TOOLS) {
      expect(spec.description.length, spec.name).toBeGreaterThan(60);
      const schema = z.toJSONSchema(z.object(spec.input)) as { type: string; properties: Record<string, unknown> };
      expect(schema.type).toBe("object");
      // list_workspaces takes no arguments.
      if (spec.name !== "list_workspaces") expect(Object.keys(schema.properties).length, spec.name).toBeGreaterThan(0);
    }
  });

  it("builds apply_commands' type list from the core registry, not a copy", () => {
    const schema = z.toJSONSchema(z.object(tool("apply_commands").input)) as any;
    expect(schema.properties.commands.items.properties.type.enum).toEqual(COMMAND_TYPES.filter((type) => type !== "batch" && type !== "applyProposal"));
    expect(schema.properties.commands.maxItems).toBe(50);
    expect(schema.required).toEqual(expect.arrayContaining(["reelId", "commands"]));
  });

  it("only names commands in apply_commands' cheat sheet that the core still has", () => {
    const sheet = /Common ones: (.*?)\. The rest/s.exec(tool("apply_commands").description)![1];
    const named = sheet.split("; ").map((entry) => /^[A-Za-z]+/.exec(entry)![0]);
    expect(named.length).toBeGreaterThan(15);
    for (const name of named) expect(COMMAND_TYPES as string[], name).toContain(name);
  });

  it("surfaces the owner's style rules where an agent edits and in the server instructions", () => {
    for (const text of [tool("apply_commands").description, SERVER_INSTRUCTIONS, STYLE_HINTS]) {
      expect(text).toMatch(/no boxed/i);
      expect(text).toMatch(/no whoosh/i);
      expect(text).toMatch(/first second/i);
    }
    expect(SERVER_INSTRUCTIONS).toMatch(/cannot post to Instagram/i);
  });

  it("marks reads read-only and exactly the tools that change data as writes", () => {
    const writes = TOOLS.filter((spec) => !spec.readOnly).map((spec) => spec.name).sort();
    expect(writes).toEqual(["add_media", "apply_commands", "create_reel", "export_reel", "generate_ai_shot"]);
  });
});

describe("runTool", () => {
  it("refuses a tool whose scope the token lacks, before running it", async () => {
    const { result, data } = await run("export_reel", { reelId: "r1" }, ctxWith(["reels:read"]));
    expect(result.isError).toBe(true);
    expect(data).toMatchObject({ ok: false, missingScopes: ["exports"] });
    expect(m.queueReelExport).not.toHaveBeenCalled();
  });

  it("counts the per-person, write and tool limits, and stops when one is used up", async () => {
    const seen: string[][] = [];
    const spec = tool("create_reel");
    const result = await runTool(spec, ctxWith(), {}, async (limits) => (seen.push(limits.map((limit) => limit.key)), false));
    expect(seen[0]).toEqual(["mcp:calls:u1", "mcp:writes:u1"]);
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ ok: false, rateLimited: true });
    expect(m.prisma.reel.create).not.toHaveBeenCalled();
    await runTool(tool("export_reel"), ctxWith(), { reelId: "r" }, async (limits) => (seen.push(limits.map((limit) => limit.key)), false));
    expect(seen[1]).toEqual(["mcp:calls:u1", "mcp:writes:u1", "mcp:export:u1"]);
  });

  it("turns a thrown error into a tool error without internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.prisma.reel.count.mockRejectedValue(new Error("connection refused 10.0.0.5:5432 password=hunter2"));
    const { result, data } = await run("list_reels");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/hunter2|10\.0\.0\.5/);
  });
});

describe("list_reels / get_reel / list_media", () => {
  it("lists only this workspace's reels, with duration and the last export", async () => {
    m.prisma.reel.count.mockResolvedValue(1);
    m.prisma.reel.findMany.mockResolvedValue([{ id: "r1", title: "Villa", revision: 3, caption: "", updatedAt: new Date("2026-10-25T10:00:00Z"), timeline: timelineOf(video), renderJobs: [{ id: "j1", status: "SUCCEEDED" }] }]);
    const { data } = await run("list_reels", { limit: 5 });
    expect(m.prisma.reel.findMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: "ws1" }, take: 5 });
    expect(data.reels[0]).toMatchObject({ id: "r1", revision: 3, durationMs: 4000, clipCount: 1, lastExport: { exportId: "j1", status: "SUCCEEDED" }, url: "https://reelwalking.com/reels/r1" });
  });

  it("reads a reel as a summary with ids and times, and says what blocks an export", async () => {
    m.loadReel.mockResolvedValue(loaded());
    m.prisma.reel.findFirst.mockResolvedValue({ caption: "Quiet." });
    m.prisma.renderJob.findFirst.mockResolvedValue(null);
    const { data } = await run("get_reel", { reelId: "r1" });
    expect(data).toMatchObject({ ok: true, reelId: "r1", revision: 3, durationMs: 4000, canExport: expect.any(Boolean), lastExport: null });
    expect(data.clips[0]).toMatchObject({ id: "c1", assetId: "a1", fileName: "pool.mp4", startMs: 0, durationMs: 4000, room: "pool" });
    expect(data.timeline).toBeUndefined();
    const full = await run("get_reel", { reelId: "r1", full: true });
    expect(full.data.timeline.clips).toHaveLength(1);
  });

  it("answers a reel from another workspace like a missing one", async () => {
    m.loadReel.mockResolvedValue(null);
    const { result, data } = await run("get_reel", { reelId: "someone-elses" });
    expect(result.isError).toBe(true);
    expect(data.message).toMatch(/No reel with that id/);
    expect(m.loadReel).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1" }), "someone-elses");
  });

  it("lists the person's own media unless the starter library is asked for", async () => {
    m.prisma.mediaAsset.findMany.mockResolvedValue([{ id: "a1", kind: "VIDEO", fileName: "pool.mp4", durationMs: 4000, shared: false }]);
    const own = await run("list_media", { kind: "VIDEO", query: "pool" });
    expect(m.prisma.mediaAsset.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws1", kind: "VIDEO", fileName: { contains: "pool", mode: "insensitive" }, instagramAudioId: null });
    expect(own.data.media[0]).toMatchObject({ id: "a1", fileName: "pool.mp4", shared: false });
    await run("list_media", { includeStarter: true });
    expect(m.prisma.mediaAsset.findMany.mock.calls[1][0].where.OR).toEqual([{ workspaceId: "ws1" }, { shared: true }]);
  });
});

describe("search_stock", () => {
  it("says so when stock search is not set up", async () => {
    m.stock.isStockConfigured.mockReturnValue(false);
    const { result, data } = await run("search_stock", { query: "villa pool" });
    expect(result.isError).toBe(true);
    expect(data.message).toMatch(/not set up/);
  });

  it("returns sets of clips with the ids add_media takes, without sample frames", async () => {
    m.stock.isStockConfigured.mockReturnValue(true);
    const clip = { source: "pixabay", id: "777", creator: "ann", creatorId: "1", url: "https://pixabay.com/videos/777/", poster: "p.jpg", file: { url: "f", width: 1080, height: 1920 }, durationMs: 8000, width: 1080, height: 1920, tags: ["villa", "pool"], sample: "SECRET-BYTES" };
    m.stock.searchStockClips.mockResolvedValue([clip]);
    m.stock.checkStockClips.mockImplementation(async (_workspaceId: string, clips: any[]) => clips);
    const { data } = await run("search_stock", { query: "villa pool" });
    expect(data.groups[0].clips[0]).toMatchObject({ id: "777", durationMs: 8000 });
    expect(JSON.stringify(data)).not.toContain("SECRET-BYTES");
  });
});

describe("create_reel", () => {
  it("creates an empty reel in this workspace", async () => {
    m.prisma.reel.count.mockResolvedValue(4);
    m.prisma.reel.create.mockResolvedValue({ id: "new", title: "Reel 5", revision: 0 });
    const { data } = await run("create_reel");
    expect(m.prisma.reel.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "ws1", title: "Reel 5" });
    expect(data).toMatchObject({ ok: true, reelId: "new", revision: 0, clipCount: 0 });
  });

  it("puts library media on the timeline in the order given", async () => {
    m.prisma.mediaAsset.findMany.mockResolvedValue([
      { id: "a1", kind: "VIDEO", fileName: "pool.mp4", durationMs: 4000 },
      { id: "a2", kind: "IMAGE", fileName: "hall.jpg", durationMs: null },
    ]);
    m.prisma.reel.count.mockResolvedValue(0);
    m.prisma.reel.create.mockResolvedValue({ id: "new", title: "T", revision: 0 });
    const { data } = await run("create_reel", { title: "T", mediaIds: ["a2", "a1"] });
    const clips = m.prisma.reel.create.mock.calls[0][0].data.timeline.clips;
    expect(clips.map((clip: any) => clip.assetId)).toEqual(["a2", "a1"]);
    expect(clips[0]).toMatchObject({ kind: "IMAGE", sourceEndMs: 3000, motion: "zoom-in" });
    expect(data.clipCount).toBe(2);
  });

  it("refuses media that is not the person's, and music", async () => {
    m.prisma.mediaAsset.findMany.mockResolvedValue([{ id: "a1", kind: "VIDEO", fileName: "x" }]);
    const missing = await run("create_reel", { mediaIds: ["a1", "other-workspace"] });
    expect(missing.data.message).toMatch(/other-workspace/);
    m.prisma.mediaAsset.findMany.mockResolvedValue([{ id: "song", kind: "AUDIO", fileName: "s.mp3" }]);
    expect((await run("create_reel", { mediaIds: ["song"] })).data.message).toMatch(/setMusic/);
    expect(m.prisma.reel.create).not.toHaveBeenCalled();
  });
});

describe("add_media", () => {
  const asset = { id: "s1", kind: "VIDEO", fileName: "pixabay-777.mp4", durationMs: 8000, isPano: false, spot: null, room: null };

  it("imports stock clips and appends them to a reel as a new revision", async () => {
    m.stock.importStockClips.mockResolvedValue({ assets: [asset], failed: [{ id: 9, error: "no mp4" }] });
    m.loadReel.mockResolvedValue(loaded());
    m.saveReelFor.mockResolvedValue({ ok: true, revision: 4 });
    const { data } = await run("add_media", { mode: "stock", stockIds: [777, 9], reelId: "r1" });
    expect(m.stock.importStockClips).toHaveBeenCalledWith("ws1", [777, 9]);
    const saved = m.saveReelFor.mock.calls[0][1];
    expect(saved).toMatchObject({ id: "r1", revision: 3 });
    expect(saved.timeline.clips.map((clip: any) => clip.assetId)).toEqual(["a1", "s1"]);
    expect(data).toMatchObject({ ok: true, failed: [{ id: 9 }], addedToReel: { reelId: "r1", revision: 4, clipCount: 2 } });
  });

  it("only fills the library when no reel is named", async () => {
    m.stock.importStockClips.mockResolvedValue({ assets: [asset], failed: [] });
    const { data } = await run("add_media", { mode: "stock", stockIds: [777] });
    expect(data.addedToReel).toBeNull();
    expect(m.saveReelFor).not.toHaveBeenCalled();
  });

  it("reports a save conflict and a missing reel without losing what was imported", async () => {
    m.stock.importStockClips.mockResolvedValue({ assets: [asset], failed: [] });
    m.loadReel.mockResolvedValue(loaded());
    m.saveReelFor.mockResolvedValue({ ok: false, reason: "conflict", message: "This reel was changed in another tab." });
    const conflict = await run("add_media", { mode: "stock", stockIds: [777], reelId: "r1" });
    expect(conflict.result.isError).toBe(true);
    expect(conflict.data.assets[0].id).toBe("s1");
    m.loadReel.mockResolvedValue(null);
    expect((await run("add_media", { mode: "stock", stockIds: [777], reelId: "nope" })).data.message).toMatch(/No reel/);
  });

  it("places existing library media, refusing ids that are not the person's", async () => {
    m.prisma.mediaAsset.findMany.mockResolvedValue([{ id: "a1", kind: "VIDEO", fileName: "pool.mp4", durationMs: 4000 }]);
    m.loadReel.mockResolvedValue(loaded());
    m.saveReelFor.mockResolvedValue({ ok: true, revision: 4 });
    expect((await run("add_media", { mode: "library", mediaIds: ["a1"], reelId: "r1" })).data.addedToReel.revision).toBe(4);
    expect((await run("add_media", { mode: "library", mediaIds: ["a1", "zz"] })).data.message).toMatch(/zz/);
  });

  it("hands out a one-shot upload URL, and records the asset once it is there", async () => {
    m.actions.createUpload.mockResolvedValue({ ok: true, objectKey: "uploads/ws1/abc.mp4", contentType: "video/mp4", uploadUrl: "https://s3.example/put?sig=1", multipart: null, thumbKey: null, thumbUrl: null });
    const prepared = await run("add_media", { mode: "prepare_upload", fileName: "pool.mp4", contentType: "video/mp4", sizeBytes: 5_000_000 });
    expect(prepared.data).toMatchObject({ objectKey: "uploads/ws1/abc.mp4", uploadUrl: "https://s3.example/put?sig=1", method: "PUT", headers: { "Content-Type": "video/mp4" } });
    m.actions.confirmUpload.mockResolvedValue({ ok: true, asset: { ...asset, id: "up1", fileName: "pool.mp4" } });
    const done = await run("add_media", { mode: "finish_upload", objectKey: "uploads/ws1/abc.mp4", fileName: "pool.mp4", durationMs: 4000, width: 1080, height: 1920 });
    expect(m.actions.confirmUpload).toHaveBeenCalledWith(expect.objectContaining({ objectKey: "uploads/ws1/abc.mp4", durationMs: 4000, thumbKey: null }));
    expect(done.data.assets[0].id).toBe("up1");
  });

  it("caps connector uploads at 32 MB in the schema and relays upload errors", async () => {
    expect(() => z.object(tool("add_media").input).parse({ mode: "prepare_upload", fileName: "a.mp4", contentType: "video/mp4", sizeBytes: 40_000_000 })).toThrow();
    m.actions.createUpload.mockResolvedValue({ ok: false, error: "a.xyz is not a supported photo, video or audio file." });
    expect((await run("add_media", { mode: "prepare_upload", fileName: "a.xyz", contentType: "x/y", sizeBytes: 10 })).data.message).toMatch(/not a supported/);
  });

  it("tells the caller what a mode is missing", async () => {
    expect((await run("add_media", { mode: "stock" })).data.message).toMatch(/stockIds/);
    expect((await run("add_media", { mode: "library" })).data.message).toMatch(/mediaIds/);
    expect((await run("add_media", { mode: "finish_upload" })).data.message).toMatch(/objectKey/);
  });
});

describe("apply_commands", () => {
  const changes = [{ kind: "clip", id: "c1", note: "trimmed" }];
  const result = (timeline = timelineOf(video)) => ({ ok: true, revision: 4, result: { timeline, changes, warning: undefined } });

  it("applies one command at the revision read, and a list as one batch", async () => {
    m.loadReel.mockResolvedValue(loaded());
    m.applyReelCommand.mockResolvedValue(result());
    const one = await run("apply_commands", { reelId: "r1", revision: 3, commands: [{ type: "setSpeed", clipId: "c1", speed: 1.5 }] });
    expect(m.applyReelCommand).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { type: "setSpeed", clipId: "c1", speed: 1.5 }, 3, { dryRun: false });
    expect(one.data).toMatchObject({ ok: true, dryRun: false, revision: 4, changes, clipCount: 1 });
    await run("apply_commands", { reelId: "r1", commands: [{ type: "setSpeed", clipId: "c1", speed: 2 }, { type: "deleteClip", clipId: "c2" }] });
    const sent = m.applyReelCommand.mock.calls[1][2];
    expect(sent).toMatchObject({ type: "batch" });
    expect(sent.commands).toHaveLength(2);
    expect(m.applyReelCommand.mock.calls[1][3]).toBe(3);
  });

  it("refuses unknown types, nested batches and proposals before touching the reel", async () => {
    // The schema stops them first, as the MCP server does before a handler runs...
    for (const commands of [[{ type: "rm -rf" }], [{ type: "batch", commands: [] }], [{ type: "applyProposal", baseGeneration: 1, proposal: {} }]]) {
      expect(() => z.object(tool("apply_commands").input).parse({ reelId: "r1", commands })).toThrow();
    }
    // ...and the handler refuses them again if it is ever called without the schema.
    for (const commands of [[{ type: "batch", commands: [] }], [{ type: "applyProposal", baseGeneration: 1, proposal: {} }], [{ type: "nope" }]]) {
      const result = await runTool(tool("apply_commands"), ctxWith(), { reelId: "r1", commands, dryRun: false, returnTimeline: false }, allowAll);
      expect(result.isError).toBe(true);
    }
    expect(m.applyReelCommand).not.toHaveBeenCalled();
  });

  it("passes a dry run through without saving, and a dry run needs only read access", async () => {
    m.loadReel.mockResolvedValue(loaded());
    m.applyReelCommand.mockResolvedValue({ ok: true, revision: 3, result: { timeline: timelineOf(video), changes, warning: "x" } });
    const dry = await run("apply_commands", { reelId: "r1", dryRun: true, commands: [{ type: "snapToBeat" }] }, ctxWith(["reels:read"]));
    expect(dry.data).toMatchObject({ ok: true, dryRun: true, revision: 3, warning: "x" });
    expect(m.applyReelCommand.mock.calls[0][4]).toEqual({ dryRun: true });
    const write = await run("apply_commands", { reelId: "r1", commands: [{ type: "snapToBeat" }] }, ctxWith(["reels:read"]));
    expect(write.result.isError).toBe(true);
    expect(write.data.message).toMatch(/reels:write/);
    expect(m.applyReelCommand).toHaveBeenCalledTimes(1);
  });

  it("relays a refusal and a stale revision with the current revision", async () => {
    m.loadReel.mockResolvedValue(loaded());
    m.applyReelCommand.mockResolvedValue({ ok: false, status: 409, message: "The reel changed since you read it." });
    const stale = await run("apply_commands", { reelId: "r1", revision: 1, commands: [{ type: "snapToBeat" }] });
    expect(stale.data).toMatchObject({ ok: false, status: 409, currentRevision: 3 });
    m.applyReelCommand.mockResolvedValue({ ok: false, status: 400, message: "No clip c9." });
    expect((await run("apply_commands", { reelId: "r1", commands: [{ type: "deleteClip", clipId: "c9" }] })).data).toMatchObject({ ok: false, status: 400, message: "No clip c9." });
  });

  it("returns the timeline only when asked", async () => {
    m.loadReel.mockResolvedValue(loaded());
    m.applyReelCommand.mockResolvedValue(result());
    expect((await run("apply_commands", { reelId: "r1", commands: [{ type: "snapToBeat" }] })).data.timeline).toBeUndefined();
    expect((await run("apply_commands", { reelId: "r1", returnTimeline: true, commands: [{ type: "snapToBeat" }] })).data.timeline.clips).toHaveLength(1);
  });

  it("answers a reel that is not the person's like a missing one", async () => {
    m.loadReel.mockResolvedValue(null);
    expect((await run("apply_commands", { reelId: "x", commands: [{ type: "snapToBeat" }] })).data.message).toMatch(/No reel/);
  });
});

describe("get_frames", () => {
  const job = { id: "j1", payload: {}, output: { objectKey: "renders/j1.mp4" } };
  beforeEach(() => {
    m.prisma.renderJob.findFirst.mockResolvedValue(job);
    m.verify.ffmpegAvailable.mockReturnValue(true);
    m.verify.exportTimeline.mockReturnValue(timelineOf(video));
    m.verify.parseTimes.mockImplementation((param: string) => param.split(",").map((s) => Math.round(Number(s) * 1000)));
    m.verify.parseWidth.mockReturnValue(270);
    m.verify.framesAt.mockResolvedValue([Buffer.from("one"), Buffer.from("two")]);
    m.verify.contactSheet.mockResolvedValue(Buffer.from("sheet"));
  });

  it("returns one contact sheet image by default, looked up in the person's workspace", async () => {
    const { result, data } = await run("get_frames", { exportId: "j1", times: [0, 1.5] });
    expect(m.prisma.renderJob.findFirst.mock.calls[0][0].where).toMatchObject({ id: "j1", workspaceId: "ws1" });
    expect(data.timesMs).toEqual([0, 1500]);
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: Buffer.from("sheet").toString("base64") });
    expect(result.content).toHaveLength(2);
  });

  it("returns separate images when asked", async () => {
    const { result } = await run("get_frames", { exportId: "j1", times: [0, 1.5], sheet: false });
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(2);
  });

  it("explains a missing export and a server without ffmpeg", async () => {
    m.prisma.renderJob.findFirst.mockResolvedValue(null);
    expect((await run("get_frames", { exportId: "nope", times: [0] })).data.message).toMatch(/No finished export/);
    m.prisma.renderJob.findFirst.mockResolvedValue(job);
    m.verify.ffmpegAvailable.mockReturnValue(false);
    expect((await run("get_frames", { exportId: "j1", times: [0] })).data.message).toMatch(/ffmpeg/);
  });

  it("limits how many frames one call may ask for", () => {
    expect(() => z.object(tool("get_frames").input).parse({ exportId: "j", times: Array.from({ length: 13 }, (_, i) => i) })).toThrow();
  });
});

describe("get_checks / get_audio_trace", () => {
  it("returns the gate and the checks with the sound's problems merged in", async () => {
    m.prisma.renderJob.findFirst.mockResolvedValue({ id: "j1", reelId: "r1", output: { objectKey: "k" } });
    m.verify.ensureChecks.mockResolvedValue({ checks: { black: [] }, source: "stored" });
    m.reelAudioTrace.mockResolvedValue({ problems: [] });
    m.verify.audioProblemsFrom.mockReturnValue([]);
    m.verify.withAudio.mockImplementation((checks: any) => ({ ...checks, audio: [] }));
    m.verify.gateFor.mockReturnValue({ blocked: false, reason: null, reasons: [], checked: true });
    const { data } = await run("get_checks", { exportId: "j1" });
    expect(m.reelAudioTrace).toHaveBeenCalledWith("ws1", "r1");
    expect(data).toMatchObject({ ok: true, exportId: "j1", source: "stored", gate: { blocked: false }, checks: { black: [], audio: [] } });
  });

  it("explains checks that are not available", async () => {
    m.prisma.renderJob.findFirst.mockResolvedValue({ id: "j1", reelId: "r1", output: { objectKey: "k" } });
    m.verify.ensureChecks.mockResolvedValue({ checks: null, source: "none", reason: "ffmpeg is not installed" });
    expect((await run("get_checks", { exportId: "j1" })).data.message).toMatch(/ffmpeg/);
  });

  it("reads the audio trace in the person's workspace", async () => {
    m.reelAudioTrace.mockResolvedValue({ reelId: "r1", revision: 3, beats: [], problems: [] });
    expect((await run("get_audio_trace", { reelId: "r1" })).data).toMatchObject({ ok: true, reelId: "r1", revision: 3 });
    expect(m.reelAudioTrace).toHaveBeenCalledWith("ws1", "r1");
    m.reelAudioTrace.mockResolvedValue(null);
    expect((await run("get_audio_trace", { reelId: "x" })).data.message).toMatch(/No reel/);
  });
});

describe("export_reel / get_export", () => {
  it("queues an export and returns its id", async () => {
    m.queueReelExport.mockResolvedValue({ ok: true });
    m.prisma.renderJob.findFirst.mockResolvedValue({ id: "j9", status: "QUEUED" });
    const { data } = await run("export_reel", { reelId: "r1" });
    expect(m.queueReelExport).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1" }), "r1");
    expect(data).toMatchObject({ ok: true, exportId: "j9", status: "QUEUED" });
  });

  it("relays what stops an export: the checks, the plan limit", async () => {
    m.queueReelExport.mockResolvedValue({ ok: false, issues: [{ level: "error", code: "empty", message: "Add a clip first." }] });
    const blocked = await run("export_reel", { reelId: "r1" });
    expect(blocked.result.isError).toBe(true);
    expect(blocked.data).toMatchObject({ message: "Add a clip first.", issues: [{ code: "empty" }] });
    m.queueReelExport.mockResolvedValue({ ok: false, issues: [], message: "That is all 3 of this month's free exports.", upgrade: true });
    expect((await run("export_reel", { reelId: "r1" })).data).toMatchObject({ message: expect.stringContaining("free exports"), upgrade: true });
  });

  it("reports progress, and the links only when the export has succeeded", async () => {
    m.prisma.renderJob.findFirst.mockResolvedValue({ id: "j9", reelId: "r1", status: "RUNNING", progress: 40, error: null, createdAt: new Date("2026-10-25T10:00:00Z"), finishedAt: null, output: null });
    const running = await run("get_export", { exportId: "j9" });
    expect(running.data).toMatchObject({ status: "RUNNING", progress: 40 });
    expect(running.data.downloadUrl).toBeUndefined();
    expect(m.prisma.renderJob.findFirst.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws1", id: "j9" });
    m.prisma.renderJob.findFirst.mockResolvedValue({ id: "j9", reelId: "r1", status: "SUCCEEDED", progress: 100, error: null, createdAt: new Date(), finishedAt: new Date(), output: { objectKey: "k" } });
    m.outputUrls.mockResolvedValue({ playUrl: "https://cdn/play", downloadUrl: "https://cdn/dl" });
    expect((await run("get_export", { reelId: "r1" })).data).toMatchObject({ status: "SUCCEEDED", playUrl: "https://cdn/play", downloadUrl: "https://cdn/dl" });
    expect(m.prisma.renderJob.findFirst.mock.calls[1][0].where).toMatchObject({ reelId: "r1" });
  });

  it("needs an id, and finds nothing for another workspace's export", async () => {
    expect((await run("get_export", {})).data.message).toMatch(/exportId or reelId/);
    m.prisma.renderJob.findFirst.mockResolvedValue(null);
    expect((await run("get_export", { exportId: "x" })).result.isError).toBe(true);
  });
});

describe("generate_ai_shot", () => {
  const args = { prompt: "Slow push in on an infinity pool at dusk" };
  beforeEach(() => {
    m.ai.aiVideoConfigured.mockReturnValue(true);
    m.ai.getAiBalance.mockResolvedValue({ remaining: 5 });
  });

  it("only quotes the first time and spends nothing", async () => {
    const { data } = await run("generate_ai_shot", args);
    expect(data).toMatchObject({ ok: true, started: false, quote: { credits: 1, remainingCredits: 5 }, requestId: expect.any(String) });
    expect(m.ai.createAiGeneration).not.toHaveBeenCalled();
  });

  it("starts the shot only when confirmCredits equals the quote, through the editor's own gate", async () => {
    m.ai.createAiGeneration.mockResolvedValue({ id: "ai1" });
    const { data } = await run("generate_ai_shot", { ...args, durationSeconds: 8, confirmCredits: 2, requestId: "6f1d8a4e-3b1c-4b43-9a53-0d7b6b2c1e11" });
    expect(m.ai.createAiGeneration).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1" }), { requestId: "6f1d8a4e-3b1c-4b43-9a53-0d7b6b2c1e11", prompt: args.prompt, referenceAssetId: undefined, durationSeconds: 8 });
    expect(data).toMatchObject({ started: true, aiShotId: "ai1", quote: { credits: 2 } });
  });

  it("refuses a confirmation that does not match, too few credits, and an unconfigured server", async () => {
    expect((await run("generate_ai_shot", { ...args, durationSeconds: 8, confirmCredits: 1 })).data.message).toMatch(/quote for 8 s is 2/);
    m.ai.getAiBalance.mockResolvedValue({ remaining: 0 });
    expect((await run("generate_ai_shot", { ...args, confirmCredits: 1 })).data.message).toMatch(/Not enough AI credits/);
    m.ai.aiVideoConfigured.mockReturnValue(false);
    expect((await run("generate_ai_shot", args)).data.message).toMatch(/not available/);
    expect(m.ai.createAiGeneration).not.toHaveBeenCalled();
  });

  it("relays the editor's own refusal (budget, storage, reference rules)", async () => {
    m.ai.createAiGeneration.mockRejectedValue(new Error("AI generation is temporarily paused."));
    expect((await run("generate_ai_shot", { ...args, confirmCredits: 1 })).data.message).toBe("AI generation is temporarily paused.");
  });

  it("refuses with the AI-off message in a workspace with AI off: no quote, no credits, no generation", async () => {
    m.prisma.workspace.findUnique.mockResolvedValue({ aiGeneration: "off" });
    const { data, result } = await run("generate_ai_shot", { ...args, confirmCredits: 1 });
    expect(result.isError).toBe(true);
    expect(data).toMatchObject({ ok: false, code: "ai_off", message: expect.stringMatching(/turned off for this workspace/) });
    expect(m.ai.getAiBalance).not.toHaveBeenCalled();
    expect(m.ai.createAiGeneration).not.toHaveBeenCalled();
  });

  it("needs the ai:generate permission", async () => {
    const { data } = await run("generate_ai_shot", args, ctxWith(["reels:read", "reels:write", "exports"]));
    expect(data.missingScopes).toEqual(["ai:generate"]);
    expect(m.ai.getAiBalance).not.toHaveBeenCalled();
  });

  it("get_ai_shot reads one of this workspace's shots", async () => {
    m.prisma.aiGeneration.findFirst.mockResolvedValue({ id: "ai1", status: "SUCCEEDED", error: null, assetId: "a9", durationSeconds: 4, credits: 1, createdAt: new Date("2026-10-25T10:00:00Z") });
    expect((await run("get_ai_shot", { aiShotId: "ai1" })).data).toMatchObject({ status: "SUCCEEDED", assetId: "a9" });
    expect(m.prisma.aiGeneration.findFirst.mock.calls[0][0].where).toEqual({ id: "ai1", workspaceId: "ws1" });
    m.prisma.aiGeneration.findFirst.mockResolvedValue(null);
    expect((await run("get_ai_shot", { aiShotId: "zz" })).result.isError).toBe(true);
  });
});

describe("list_workspaces", () => {
  const home = { id: "ws1", name: "Reel Walk", slug: "reelwalking", aiGeneration: "on" };
  const lastMile = { id: "ws2", name: "Last Mile", slug: "last-mile", aiGeneration: "off" };

  it("names the bound workspace and the person's others, and says switching means reconnecting", async () => {
    m.prisma.workspaceMember.findMany.mockResolvedValue([{ workspaceId: "ws1", role: "OWNER" }, { workspaceId: "ws2", role: "OWNER" }]);
    m.prisma.workspace.findMany.mockResolvedValue([home, lastMile]);
    const ctx = { ...ctxWith(), user: { id: "u1", workspaceId: "ws2", homeWorkspaceId: "ws1", role: "OWNER", email: "a@example.com", workspace: lastMile } as any };
    const { data } = await run("list_workspaces", {}, ctx);
    expect(data.workspace).toEqual({ id: "ws2", name: "Last Mile", role: "owner", aiGeneration: "off" });
    expect(data.others).toEqual([{ id: "ws1", name: "Reel Walk", role: "owner", aiGeneration: "on" }]);
    expect(data.note).toMatch(/disconnecting and reconnecting/);
  });

  it("needs only the read permission and changes nothing", async () => {
    expect(tool("list_workspaces").readOnly).toBe(true);
    expect(tool("list_workspaces").scopes).toEqual(["reels:read"]);
  });
});
