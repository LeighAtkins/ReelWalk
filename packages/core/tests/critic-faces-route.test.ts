import { beforeEach, describe, expect, it, vi } from "vitest";

// The critic's face facts route (ADR 0062): signed in only, this workspace's generations only,
// and only the numbers the face check needs.

const mocks = vi.hoisted(() => ({
  user: { id: "u", workspaceId: "w", email: "owner@test.invalid" } as { id: string; workspaceId: string; email: string } | null,
  aiGeneration: { findMany: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => mocks.user }));
vi.mock("@reelwalk/db", () => ({ prisma: { aiGeneration: mocks.aiGeneration } }));
// Web routes are compiled by the web workspace; load them under Vitest's web aliases here.
const facesModule = "@/app/api/ai/faces/route";
const { GET } = await import(facesModule);

const get = (query: string) => GET(new Request(`https://reelwalking.com/api/ai/faces${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: "u", workspaceId: "w", email: "owner@test.invalid" };
});

describe("GET /api/ai/faces", () => {
  it("requires a session", async () => {
    mocks.user = null;
    expect((await get("?assets=ai-1")).status).toBe(401);
    expect(mocks.aiGeneration.findMany).not.toHaveBeenCalled();
  });

  it("asks nothing for no assets", async () => {
    expect(await (await get("")).json()).toEqual({ faces: [] });
    expect(mocks.aiGeneration.findMany).not.toHaveBeenCalled();
  });

  it("reads only this workspace's rows for the asked assets and returns only the face facts", async () => {
    mocks.aiGeneration.findMany.mockResolvedValue([
      { assetId: "ai-1", shot: { prompt: "secret prompt", line: "Welcome home" }, identityScore: 0.8,
        identityChecks: [{ end: "first", attempt: 1, samePerson: true, confidence: 0.8, faceHeightPx: 190, minFacePx: 165, eyesAndMouthRendered: true, locate: [{ box: [1, 2, 3, 4] }] }] },
    ]);
    const response = await get("?assets=ai-1,ai-1,%20ai-2");
    expect(mocks.aiGeneration.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w", assetId: { in: ["ai-1", "ai-2"] } } }));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ faces: [{ assetId: "ai-1", floorPx: 165, faceHeightPx: 190, identityScore: 0.8, eyesAndMouthRendered: true }] });
  });
});
