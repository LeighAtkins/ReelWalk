import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportAllSummary } from "../src";

// The variants page's server side (ADR 0063): how often Instagram is asked
// for a set's numbers, and Export all's confirmed count and workspace lock.
const state = vi.hoisted(() => ({
  posts: [] as { mediaId: string; publishedAt: Date; renderJob: { reelId: string } }[],
  token: "token" as string | null,
  insights: [] as string[],
  answer: null as unknown,
  updates: [] as { where: { reelId: string }; data: Record<string, unknown> }[],
  locked: true,
  group: null as unknown,
  queued: [] as string[],
  refuseAfter: Infinity,
}));

vi.mock("@reelwalk/db", () => ({
  prisma: {
    scheduledPost: { findMany: async () => state.posts },
    socialAccount: { findUnique: async () => (state.token ? { messagingToken: state.token } : null) },
    reelVariant: { update: async (args: { where: { reelId: string }; data: Record<string, unknown> }) => { state.updates.push(args); return {}; } },
    variantGroup: { findFirst: async () => state.group },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $queryRaw: async () => [{ locked: state.locked }] }),
  },
}));
vi.mock("@/lib/instagram-messaging", () => ({ postInsights: async (_token: string, mediaId: string) => { state.insights.push(mediaId); return state.answer; } }));
vi.mock("@/lib/export-reel", () => ({
  queueReelExport: async (_user: unknown, reelId: string) => {
    if (state.queued.length >= state.refuseAfter) return { ok: false, issues: [], message: "3 exports are already rendering." };
    state.queued.push(reelId);
    return { ok: true };
  },
}));
vi.mock("@/lib/plans", () => ({ workspacePlan: async () => ({ plan: {} }), exportsThisMonth: async () => 0 }));
vi.mock("@/lib/quotas", () => ({ isUnlimited: async () => false }));
vi.mock("@/lib/media-scope", () => ({ mediaScope: () => ({}) }));

type Variant = { reelId: string; hook: string; lengthS: number; views: number | null; reach: number | null; mediaId: string | null; insightsAt: Date | null; insightsCheckedAt: Date | null };
const variantsModule = "@/lib/variants";
const lib = (await import(variantsModule)) as {
  refreshVariantInsights: (workspaceId: string, set: { variants: Variant[] }, options: { live: boolean; now?: Date }) => Promise<{ state: string; winner: string | null; numbers: Map<string, { views: number | null; postedAt: Date | null }> }>;
  exportVariantSet: (user: { id: string; workspaceId: string }, groupId: string, confirmed: number) => Promise<{ queued: number; refused: string | null; busy?: true } | null>;
};

const NOW = new Date("2026-10-21T12:00:00Z");
const variant = (reelId: string, extra: Partial<Variant> = {}): Variant => ({ reelId, hook: "hero", lengthS: 15, views: null, reach: null, mediaId: null, insightsAt: null, insightsCheckedAt: null, ...extra });
const posted = (reelId: string, mediaId: string, daysAgo = 1) => ({ mediaId, publishedAt: new Date(NOW.getTime() - daysAgo * 86_400_000), renderJob: { reelId } });

describe("variant insights", () => {
  beforeEach(() => {
    state.posts = [];
    state.token = "token";
    state.insights = [];
    state.answer = null;
    state.updates = [];
  });

  it("asks nothing when none is posted", async () => {
    const result = await lib.refreshVariantInsights("w", { variants: [variant("a"), variant("b")] }, { live: true, now: NOW });
    expect(result.state).toBe("unposted");
    expect(state.insights).toEqual([]);
  });

  it("a failed read is stored as an attempt, so the next load within ten minutes does not ask again", async () => {
    state.posts = [posted("a", "m-a")];
    const first = await lib.refreshVariantInsights("w", { variants: [variant("a")] }, { live: true, now: NOW });
    expect(state.insights).toEqual(["m-a"]);
    expect(first.state).toBe("waiting");
    expect(state.updates[0]).toMatchObject({ where: { reelId: "a" }, data: { mediaId: "m-a", insightsCheckedAt: NOW } });
    state.insights = [];
    const fiveMinutesLater = new Date(NOW.getTime() + 5 * 60_000);
    await lib.refreshVariantInsights("w", { variants: [variant("a", { mediaId: "m-a", insightsCheckedAt: NOW })] }, { live: true, now: fiveMinutesLater });
    expect(state.insights).toEqual([]);
    const elevenMinutesLater = new Date(NOW.getTime() + 11 * 60_000);
    await lib.refreshVariantInsights("w", { variants: [variant("a", { mediaId: "m-a", insightsCheckedAt: NOW })] }, { live: true, now: elevenMinutesLater });
    expect(state.insights).toEqual(["m-a"]);
  });

  it("the page's own refreshes while rendering ask nothing and show what is stored, with each post's date", async () => {
    state.posts = [posted("a", "m-a", 3), posted("b", "m-b", 1)];
    const stored = [variant("a", { mediaId: "m-a", views: 900, reach: 700, insightsCheckedAt: new Date(0) }), variant("b", { mediaId: "m-b", views: 400, reach: 300, insightsCheckedAt: new Date(0) })];
    const result = await lib.refreshVariantInsights("w", { variants: stored }, { live: false, now: NOW });
    expect(state.insights).toEqual([]);
    expect(result.winner).toBe("a");
    expect(result.numbers.get("a")!.postedAt).toEqual(posted("a", "m-a", 3).publishedAt);
  });

  it("stores numbers read, and does not carry a variant's numbers over to a new post of it", async () => {
    state.posts = [posted("a", "m-new")];
    state.answer = { views: 50, reach: 40, likes: null, comments: null, saved: null, shares: null, avgWatchMs: null };
    const result = await lib.refreshVariantInsights("w", { variants: [variant("a", { mediaId: "m-old", views: 9000, reach: 8000, insightsCheckedAt: NOW })] }, { live: true, now: NOW });
    // A new media id is asked at once, whatever the last attempt.
    expect(state.insights).toEqual(["m-new"]);
    expect(result.numbers.get("a")!.views).toBe(50);
    expect(state.updates[0].data).toMatchObject({ views: 50, reach: 40, mediaId: "m-new", insightsAt: NOW, insightsCheckedAt: NOW });
  });

  it("says when there is no connection to read with, or a reconnect is needed", async () => {
    state.posts = [posted("a", "m-a")];
    state.token = null;
    expect((await lib.refreshVariantInsights("w", { variants: [variant("a")] }, { live: true, now: NOW })).state).toBe("no-connection");
    state.token = "token";
    state.answer = "permission";
    expect((await lib.refreshVariantInsights("w", { variants: [variant("a")] }, { live: true, now: NOW })).state).toBe("permission");
  });
});

describe("export all", () => {
  const reel = (id: string, job?: { status: string; createdAt: Date }) => ({ reel: { id, updatedAt: new Date("2026-10-21T10:00:00Z"), renderJobs: job ? [job] : [] } });
  beforeEach(() => {
    state.locked = true;
    state.queued = [];
    state.refuseAfter = Infinity;
    state.group = {
      variants: [
        reel("a"),
        reel("b", { status: "SUCCEEDED", createdAt: new Date("2026-10-21T11:00:00Z") }),
        reel("c", { status: "FAILED", createdAt: new Date("2026-10-21T11:00:00Z") }),
        reel("d", { status: "SUCCEEDED", createdAt: new Date("2026-10-21T09:00:00Z") }),
        reel("e"),
      ],
    };
  });
  const user = { id: "u", workspaceId: "w" };

  it("queues the variants that need an export, never more than the number confirmed", async () => {
    expect(await lib.exportVariantSet(user, "g", 6)).toEqual({ queued: 4, refused: null });
    // b's export is newer than its last edit; c failed and d was edited since: both again.
    expect(state.queued).toEqual(["a", "c", "d", "e"]);
    state.queued = [];
    expect((await lib.exportVariantSet(user, "g", 2))!.queued).toBe(2);
    expect(state.queued).toEqual(["a", "c"]);
  });

  it("a second Export all while one holds the workspace lock starts nothing", async () => {
    state.locked = false;
    const result = await lib.exportVariantSet(user, "g", 6);
    expect(result).toMatchObject({ queued: 0, busy: true });
    expect(state.queued).toEqual([]);
  });

  it("stops at the first refusal and reports it", async () => {
    state.refuseAfter = 2;
    expect(await lib.exportVariantSet(user, "g", 6)).toEqual({ queued: 2, refused: "3 exports are already rendering." });
  });

  it("the confirmation says what it uses", () => {
    expect(exportAllSummary(6, 30, 3)).toBe("This uses 6 of your 30 exports left this month. 3 can render at once now; tap Export all again for the rest when they finish.");
    expect(exportAllSummary(6, 2, 6)).toBe("This uses 2 of your 2 exports left this month. Only 2 exports can start; the rest wait for next month or a bigger plan.");
    expect(exportAllSummary(4, null, 6)).toBe("This starts 4 exports.");
  });
});
