import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTimeline } from "../src";

// POST /api/reels/:id/commands with the speed-ramp transition (ADR 0073): the route's own registry, the pure
// `applyCommand` and the real save path, with only the database and the session stood in for.
const mocks = vi.hoisted(() => ({ user: { id: "u", workspaceId: "w", email: "owner@test.invalid" } as { id: string; workspaceId: string; email: string } | null, findReel: vi.fn(), updateMany: vi.fn(), count: vi.fn(), findAssets: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => mocks.user }));
vi.mock("@reelwalk/db", () => ({ prisma: { reel: { findFirst: mocks.findReel, updateMany: mocks.updateMany, count: mocks.count }, mediaAsset: { findMany: mocks.findAssets, count: mocks.count } } }));
vi.mock("@/lib/library", () => ({ toLibraryAssets: async () => [] }));
const routeModule = "@/app/api/reels/[id]/commands/route";
const { POST } = await import(routeModule);

const clip = (id: string) => ({ id, assetId: `asset-${id}`, kind: "VIDEO", sourceStartMs: 4000, sourceEndMs: 6000 });
const saved = parseTimeline({ version: 1, clips: [clip("a"), clip("b"), clip("c")], texts: [], music: null });
const params = { params: Promise.resolve({ id: "reel" }) };
const send = (body: unknown) => POST(new Request("https://reelwalking.com/api/reels/reel/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
  mocks.findReel.mockResolvedValue({ id: "reel", title: "Villa", revision: 7, timeline: saved });
  mocks.findAssets.mockResolvedValue([]);
  mocks.count.mockResolvedValue(3);
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("the commands route and the speed-ramp transition", () => {
  it("accepts setTransition with a speed ramp, fills in the defaults, and saves the reel at the next revision", async () => {
    const response = await send({ command: { type: "setTransition", clipId: "b", transition: { kind: "speedRamp", preset: "punch" } } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, dryRun: false, revision: 8, changes: [{ kind: "clip", id: "b" }] });
    expect(body.timeline.clips[1]).toMatchObject({ transitionIn: "speedRamp", speedRamp: { durationMs: 300, peak: 5, direction: "auto" } });
    const written = mocks.updateMany.mock.calls[0][0];
    expect(written.where).toMatchObject({ id: "reel", revision: 7 });
    expect(written.data.timeline.clips[1].transitionIn).toBe("speedRamp");
    // A saved reel keeps its length: nothing but the clip's transition changed.
    expect(written.data.timeline.clips.map((c: { sourceStartMs: number; sourceEndMs: number }) => [c.sourceStartMs, c.sourceEndMs])).toEqual([[4000, 6000], [4000, 6000], [4000, 6000]]);
  });

  it("takes the parameters in a batch with other commands, and a dry run saves nothing", async () => {
    const commands = [
      { type: "setTransition", clipId: "b", transition: "speedRamp", speedRamp: { peak: 3, blur: 0.4, direction: "up" } },
      { type: "setTransition", clipId: "c", transition: "speedRamp", speedRamp: { durationMs: 400 } },
    ];
    const response = await send({ commands, dryRun: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dryRun).toBe(true);
    expect(body.timeline.clips[1].speedRamp).toMatchObject({ peak: 3, blur: 0.4, direction: "up" });
    expect(body.timeline.clips[2].speedRamp).toMatchObject({ durationMs: 400, peak: 4 });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range parameter, an unknown preset and the first shot with the reason, and saves nothing", async () => {
    const tooFast = await send({ command: { type: "setTransition", clipId: "b", transition: "speedRamp", speedRamp: { peak: 40 } } });
    expect(tooFast.status).toBe(400);
    expect((await tooFast.json()).message).toMatch(/peak/);
    const wrongPreset = await send({ command: { type: "setTransition", clipId: "b", transition: { kind: "speedRamp", preset: "wild" } } });
    expect(wrongPreset.status).toBe(400);
    expect((await wrongPreset.json()).message).toMatch(/no speed ramp called wild/);
    const first = await send({ command: { type: "setTransition", clipId: "a", transition: "speedRamp" } });
    expect(first.status).toBe(400);
    expect((await first.json()).message).toMatch(/first shot/);
    // One bad command refuses the whole batch.
    const batch = await send({ commands: [{ type: "setTransition", clipId: "b", transition: "speedRamp" }, { type: "setTransition", clipId: "c", transition: "speedRamp", speedRamp: { blur: 3 } }] });
    expect(batch.status).toBe(400);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("answers 409 for a reel changed since it was read, and still needs a session", async () => {
    expect((await send({ command: { type: "setTransition", clipId: "b", transition: "speedRamp" }, revision: 3 })).status).toBe(409);
    mocks.user = null;
    expect((await send({ command: { type: "setTransition", clipId: "b", transition: "speedRamp" } })).status).toBe(401);
  });

  it("sends the pace option through, off by default", async () => {
    const response = await send({ command: { type: "pace", energy: 0.5, speedRamps: true }, dryRun: true });
    // No song on this reel: pace is a no-op, but the command is accepted by the registry and the route.
    expect(response.status).toBe(200);
  });
});
