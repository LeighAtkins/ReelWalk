import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTimeline, type Command } from "@reelwalk/core";

// The finding itself (ffmpeg, the model, the tracker) is covered where it runs; this is the command boundary.
const place = vi.fn();
const search = vi.fn();
vi.mock("@/lib/surface-service", () => ({ placeOnSurface: (...a: unknown[]) => place(...a), searchSurfaces: (...a: unknown[]) => search(...a) }));
vi.mock("@/lib/surface-server", () => ({ surfaceDecodeAvailable: async () => true }));
vi.mock("@/lib/surface-vision", () => ({ lookForSurfaces: async () => ({}), surfaceVisionAvailable: () => false }));

import { hasUnresolvedSurface, resolveSurfaceCommands } from "./surface-command";

const timeline = parseTimeline({
  version: 1,
  clips: [
    { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
    { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
  ],
  texts: [{ id: "t", text: "THE LODGE", startMs: 4500, endMs: 6000, style: "elegant" }, { id: "u", text: "ALPINE VIEWS", startMs: 500, endMs: 1500, style: "elegant" }],
  music: null,
});
const asset = (id: string) => ({ id, url: `https://cdn.example/${id}.mp4`, width: 1080, height: 1920 }) as never;
const loaded = { id: "r", title: "r", revision: 3, brandKit: null, timeline, library: { v1: asset("v1"), v2: { id: "v2", url: "https://cdn.example/v2.mp4", width: null, height: 1920 } as never } };
const found = { search: { candidates: [{ id: "c1" }], rejected: [], horizonY: 0.4, lines: 9 }, sourceMs: 500, vision: { used: false } };
const placed = { ok: true, placement: { corners: [0.2, 0.3, 0.8, 0.3, 0.8, 0.4, 0.2, 0.4], ink: { color: "#f4eee2", shadow: "soft" } }, candidate: { id: "c1", kind: "wall", label: "Wall", texture: { points: 40, coverage: 0.5 } }, tracking: "tracked", quality: { grade: "good" }, notes: ["Followed."], search: found.search, vision: found.vision };

beforeEach(() => { place.mockReset(); search.mockReset(); place.mockResolvedValue(placed); search.mockResolvedValue(found); });

describe("resolveSurfaceCommands", () => {
  it("leaves every other command, and a placeOnSurface that already has its surface, alone", async () => {
    const other: Command = { type: "updateText", textId: "t", patch: {} };
    expect(await resolveSurfaceCommands(loaded, other)).toEqual({ ok: true, command: other, reports: [] });
    const done: Command = { type: "placeOnSurface", textId: "t", placement: { corners: [0, 0, 1, 0, 1, 1, 0, 1] } };
    expect(hasUnresolvedSurface(done)).toBe(false);
    expect(hasUnresolvedSurface({ type: "placeOnSurface", textId: "t" })).toBe(true);
    expect(hasUnresolvedSurface({ type: "batch", commands: [other, { type: "placeOnSurface", textId: "t" }] })).toBe(true);
    expect(place).not.toHaveBeenCalled();
  });

  it("finds the surface and sends the pure command its placement", async () => {
    const result = await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u", clipId: "a", atMs: 1000, pick: "wall" }, { look: null });
    if (!result.ok) throw new Error(result.message);
    expect(result.command).toMatchObject({ type: "placeOnSurface", textId: "u", clipId: "a", atMs: 1000, placement: placed.placement });
    expect(result.reports[0]).toMatchObject({ textId: "u", clipId: "a", atMs: 1000, chosen: { kind: "wall", tracking: "tracked", notes: ["Followed."] } });
    // The picture, the shot's place in the reel and the kind asked for reach the finder.
    expect(place.mock.calls[0][0]).toMatchObject({ clipStartMs: 0, atMs: 1000, source: { src: "https://cdn.example/v1.mp4", width: 1080, height: 1920 } });
    expect(place.mock.calls[0][1]).toMatchObject({ pick: "wall" });
  });

  it("takes the shot the title starts in, and its first moment, when no clip or time is given", async () => {
    await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u" }, { look: null });
    expect(place.mock.calls[0][0]).toMatchObject({ atMs: 500, clip: { id: "a" } });
    place.mockClear();
    // The second title starts in clip b; clip b's media has no size on record.
    const r = await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "t" }, { look: null });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("answers a dry run with the candidates only: nothing is tracked and no command is left to apply", async () => {
    const result = await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u", clipId: "a", atMs: 1000 }, { dryRun: true, look: null });
    if (!result.ok) throw new Error(result.message);
    expect(result.command).toBeNull();
    expect(result.reports[0].candidates).toEqual([{ id: "c1" }]);
    expect(result.reports[0].chosen).toBeUndefined();
    expect(place).not.toHaveBeenCalled();
  });

  it("resolves the surface commands inside a batch and keeps the rest in order", async () => {
    const result = await resolveSurfaceCommands(loaded, { type: "batch", commands: [{ type: "updateText", textId: "t", patch: { size: 1 } }, { type: "placeOnSurface", textId: "u", clipId: "a", atMs: 900 }] }, { look: null });
    if (!result.ok || result.command?.type !== "batch") throw new Error("expected a batch");
    expect(result.command.commands.map((c) => c.type)).toEqual(["updateText", "placeOnSurface"]);
    expect(result.command.commands[1]).toMatchObject({ placement: placed.placement });
  });

  it("passes a spot and size on the surface to the finder, and refuses a malformed one (ADR 0084)", async () => {
    const fit = { at: { x: 0.3, y: 0.38 }, capHeight: 0.025 };
    await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u", clipId: "a", atMs: 1000, fit }, { look: null });
    expect(place.mock.calls[0][1]).toMatchObject({ fit });
    for (const bad of [{ at: { x: "a", y: 0.3 } }, { at: { x: 0.3, y: 0.3 }, capHeight: 0.5 }, { capHeight: 0.02 }]) {
      expect(await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u", clipId: "a", atMs: 1000, fit: bad as never }, { look: null })).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/fit must be/) });
    }
  });

  it("says plainly what is wrong with the request", async () => {
    expect(await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "nope" }, { look: null })).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/no text called nope/) });
    expect(await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u", clipId: "zzz" }, { look: null })).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/no clip called zzz/) });
    // 5 s is in clip b, not clip a (0–4 s).
    expect(await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u", clipId: "a", atMs: 5000 }, { look: null })).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/outside clip a/) });
  });

  it("passes on the finder's refusal (nothing flat and large enough) and never invents a placement", async () => {
    place.mockResolvedValue({ ok: false, message: "No surface in that frame could carry the title", search: found.search, vision: found.vision });
    const result = await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u", clipId: "a", atMs: 900 }, { look: null });
    expect(result).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/No surface/) });
  });

  it("refuses with 503 and a way forward when this server cannot read frames", async () => {
    const result = await resolveSurfaceCommands(loaded, { type: "placeOnSurface", textId: "u" }, { decodeAvailable: async () => false });
    expect(result).toMatchObject({ ok: false, status: 503, message: expect.stringMatching(/placement\.corners/) });
  });
});
