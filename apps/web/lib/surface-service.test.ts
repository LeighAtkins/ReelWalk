import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, SurfaceHints } from "@reelwalk/core";

const findSurfaces = vi.fn();
const trackTitleFromFrames = vi.fn();
vi.mock("@reelwalk/core", async (original) => ({ ...(await original<typeof import("@reelwalk/core")>()), findSurfaces: (...a: unknown[]) => findSurfaces(...a), trackTitleFromFrames: (...a: unknown[]) => trackTitleFromFrames(...a) }));
const flat = { data: new Float32Array(360 * 640).fill(120), width: 360, height: 640 };
vi.mock("@/lib/surface-server", () => ({
  readSourceFrame: async () => flat,
  presentedJpeg: async () => Buffer.from("jpeg"),
  readTrackingFrames: async (_s: unknown, _c: unknown, from: number, to: number, count: number) => ({ frames: Array.from({ length: count }, () => flat), times: Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1)) }),
}));

import { placeOnSurface, searchSurfaces, sourceTimeAt } from "./surface-service";

const clip = { id: "c", assetId: "a", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 5000, speed: 1, volume: 1, fit: "cover", filter: "none", motion: "none", zoom: 1, pano: null, spot: null, room: null, transitionIn: "cut" } as Clip;
const target = { source: { src: "x.mp4", width: 1080, height: 1920 }, clip, clipStartMs: 2000, text: { text: "THE LODGE" }, atMs: 2500 };
const candidate = (patch: Record<string, unknown> = {}) => ({ id: "c1", kind: "wall", label: "Wall", source: "vision", plane: [0.1, 0.2, 0.9, 0.2, 0.9, 0.6, 0.1, 0.6], placement: [0.2, 0.3, 0.8, 0.3, 0.8, 0.4, 0.2, 0.4], area: 0.3, texture: { points: 40, coverage: 0.5 }, tracking: "surface", scores: { total: 0.8 }, ink: { color: "#f4eee2", shadow: "soft", luminance: 0.2, contrast: 12 }, reasons: [], ...patch });
const searchOf = (...candidates: unknown[]) => ({ candidates, rejected: [], horizonY: 0.4, lines: 12 });
const tracked = { path: [{ t: 0, x: 0, y: 0, q: [0.2, 0.3, 0.8, 0.3, 0.8, 0.4, 0.2, 0.4] }, { t: 1, x: 0, y: 0, q: [0.2, 0.3, 0.8, 0.3, 0.8, 0.4, 0.2, 0.4] }], pin: { assetId: "a", fromMs: 1000, toMs: 5000 }, lostAtMs: null, quality: { grade: "good", inliers: 30, confidence: 0.95, points: 40, held: 0, steps: 40 }, confidence: [1, 1] };

beforeEach(() => { findSurfaces.mockReset(); trackTitleFromFrames.mockReset(); findSurfaces.mockReturnValue(searchOf(candidate())); trackTitleFromFrames.mockResolvedValue(tracked); });

describe("sourceTimeAt", () => {
  it("maps reel time into the clip's source window and keeps it a frame inside the end", () => {
    expect(sourceTimeAt(clip, 2000, 2500)).toBe(1500);
    expect(sourceTimeAt(clip, 2000, 100)).toBe(1000);
    expect(sourceTimeAt(clip, 2000, 99_000)).toBeLessThanOrEqual(4960);
    expect(sourceTimeAt({ ...clip, speed: 2 }, 2000, 2500)).toBe(2000);
  });
});

describe("searchSurfaces", () => {
  it("asks the model what it sees, and goes on with the edges alone when it cannot answer", async () => {
    const look = vi.fn().mockRejectedValue(new Error("Naming surfaces is not set up on this deployment."));
    const found = await searchSurfaces(target, { look });
    expect(found.vision).toMatchObject({ used: false, error: expect.stringMatching(/not set up/) });
    expect(findSurfaces).toHaveBeenCalledOnce();
    expect(findSurfaces.mock.calls[0][2]).toEqual({});
    expect(found.search.candidates).toHaveLength(1);
  });

  it("gives the finder the model's regions and reports what the look cost", async () => {
    const hints: SurfaceHints = { regions: [{ kind: "wall", quad: [0.1, 0.2, 0.9, 0.2, 0.9, 0.6, 0.1, 0.6], confidence: 0.9 }], horizonY: 0.4 };
    const found = await searchSurfaces(target, { look: async () => ({ hints, model: "m", usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 }, costUsd: 0.0003, ms: 900 }) });
    expect(findSurfaces.mock.calls[0][2]).toEqual(hints);
    expect(found.vision).toMatchObject({ used: true, model: "m", costUsd: 0.0003, regions: 1 });
  });

  it("sizes the title for the finder from its words", async () => {
    await searchSurfaces({ ...target, text: { text: "ALPINE\nVIEWS" } });
    const stacked = findSurfaces.mock.calls[0][1].aspect as number;
    await searchSurfaces({ ...target, text: { text: "ALPINE VIEWS" } });
    expect(stacked).toBeLessThan(findSurfaces.mock.calls[1][1].aspect);
  });
});

describe("placeOnSurface", () => {
  it("follows a surface with detail through the whole shot, taking features from the whole wall", async () => {
    const out = await placeOnSurface(target, { look: null });
    if (!out.ok) throw new Error(out.message);
    expect(out.tracking).toBe("tracked");
    expect(out.placement.pinned?.pin.assetId).toBe("a");
    expect(out.placement.timing).toEqual({ startMs: 2000, endMs: 6000 });
    expect(out.placement.corners).toEqual(candidate().placement);
    expect(out.placement.ink).toEqual({ color: "#f4eee2", shadow: "soft" });
    const input = trackTitleFromFrames.mock.calls[0][0];
    expect(input.text.surface).toEqual(candidate().placement);
    expect(input.text.support).toEqual(candidate().plane);
    expect(input.clipStartMs).toBe(2000);
    expect(out.notes.join(" ")).toMatch(/good track/);
  });

  it("places a surface with nothing to follow fixed, says so, and never tries the tracker", async () => {
    findSurfaces.mockReturnValue(searchOf(candidate({ kind: "sky", label: "Sky or ceiling", tracking: "fixed", texture: { points: 0, coverage: 0 } })));
    const out = await placeOnSurface(target, { look: null });
    if (!out.ok) throw new Error(out.message);
    expect(out.tracking).toBe("fixed");
    expect(out.placement.pinned).toBeUndefined();
    expect(out.placement.timing).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/does not follow the camera/);
    expect(trackTitleFromFrames).not.toHaveBeenCalled();
  });

  it("falls back to a fixed placement, with the tracker's reason, when the tracker cannot follow it", async () => {
    trackTitleFromFrames.mockResolvedValue({ error: "Could not follow this surface: it was lost 1.2 s in (covered, out of frame, or changed too much).", reason: "plane-lost" });
    const out = await placeOnSurface(target, { look: null });
    if (!out.ok) throw new Error(out.message);
    expect(out.tracking).toBe("failed");
    expect(out.placement.corners).toEqual(candidate().placement); // the title is still placed, never dropped
    expect(out.placement.pinned).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/Could not follow this surface.*placed fixed/);
  });

  it("does not track a photo, or when asked not to", async () => {
    const photo = await placeOnSurface({ ...target, clip: { ...clip, kind: "IMAGE" } as Clip }, { look: null });
    expect(photo.ok && photo.tracking).toBe("fixed");
    const asked = await placeOnSurface(target, { look: null, track: false });
    expect(asked.ok && asked.notes.join(" ")).toMatch(/without tracking, as asked/);
    expect(trackTitleFromFrames).not.toHaveBeenCalled();
  });

  it("takes the kind asked for, and says what the frame does show when there is none", async () => {
    findSurfaces.mockReturnValue(searchOf(candidate({ id: "w" }), candidate({ id: "f", kind: "floor", label: "Floor" })));
    const floor = await placeOnSurface(target, { pick: "floor", look: null });
    expect(floor.ok && floor.candidate.id).toBe("f");
    const sky = await placeOnSurface(target, { pick: "sky", look: null });
    expect(sky).toMatchObject({ ok: false, message: expect.stringMatching(/no sky in that frame; it shows wall, floor/) });
  });

  it("explains when nothing in the frame can carry the title", async () => {
    findSurfaces.mockReturnValue(searchOf());
    const out = await placeOnSurface(target, { look: null });
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/Try another moment/) });
  });
});
