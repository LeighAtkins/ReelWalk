import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildListingCampaign, campaignFactsSchema } from "@reelwalk/core";

// Keep the real campaign -> queueReelExport -> commitReelExport boundary.
// Only external DB, queue, capacity and plan services are replaced.
const mock = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    listingCampaign: { findUniqueOrThrow: vi.fn() },
    reel: { findUniqueOrThrow: vi.fn() },
    renderJob: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    campaignReview: { create: vi.fn(), updateMany: vi.fn() },
  },
  campaign: vi.fn(), reel: vi.fn(), media: vi.fn(), queue: vi.fn(),
}));
vi.mock("@reelwalk/db", () => ({ prisma: {
  $transaction: (work: (tx: typeof mock.tx) => unknown) => work(mock.tx),
  listingCampaign: { findFirst: mock.campaign },
  reel: { findFirst: mock.reel }, mediaAsset: { findMany: mock.media },
} }));
vi.mock("./funnel", () => ({ recordFunnelEvent: vi.fn() }));
vi.mock("./plans", () => ({ workspacePlan: async () => ({ plan: { id: "test", outputWidth: 1080, watermark: false } }) }));
vi.mock("./quotas", () => ({ exportBlockedReason: async () => null }));
vi.mock("./render-capacity", () => ({ ensureWorkerRunning: vi.fn() }));
vi.mock("./render-jobs", () => ({ queueRenderJob: mock.queue, flushOutbox: vi.fn(), renderRouteFor: () => "LOCAL", outputUrls: vi.fn() }));
vi.mock("./media-scope", () => ({ mediaScope: (workspaceId: string) => ({ workspaceId }) }));
import { createCampaignReview, exportCampaignOutput, reviewCurrent } from "./listing-campaigns";
import { queueReelExport } from "./export-reel";

const user = { id: "owner", workspaceId: "workspace" };
const facts = campaignFactsSchema.parse({ address: "Demo house", openHome: "Saturday", disclosure: "Illustrative property; source credited" });
const cut = buildListingCampaign({ version: 1, clips: [{ id: "clip", assetId: "photo", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 8000 }], texts: [], music: null }, facts)[0];
const reel = () => ({ id: "hero", workspaceId: user.workspaceId, title: "Demo campaign · hero", caption: cut.caption, timeline: cut.timeline, revision: 2 });
const campaign = () => ({ id: "campaign", workspaceId: user.workspaceId, revision: 0, outputs: [{ id: "output", reelId: "hero", reel: { ...reel(), renderJobs: [] } }] });

beforeEach(() => {
  vi.resetAllMocks();
  mock.campaign.mockResolvedValue(campaign());
  mock.reel.mockResolvedValue(reel());
  mock.media.mockResolvedValue([{ id: "photo", kind: "IMAGE", objectKey: "private/photo.jpg" }]);
  mock.tx.$queryRaw.mockResolvedValue([{ id: "locked", revision: 2 }]);
  mock.tx.listingCampaign.findUniqueOrThrow.mockResolvedValue(campaign());
  mock.tx.reel.findUniqueOrThrow.mockResolvedValue(reel());
  mock.tx.renderJob.findMany.mockResolvedValue([]);
  mock.tx.renderJob.create.mockImplementation(async ({ data }) => ({ id: "export", ...data }));
});

describe("campaign export and review handoff", () => {
  it("freezes listing copy through the real export helper, reuses the job, and admits its review", async () => {
    await expect(exportCampaignOutput(user, "campaign", "hero", 2, 0)).resolves.toBe("export");
    const saved = mock.tx.renderJob.create.mock.calls[0][0].data;
    expect(saved.caption).toBe(cut.caption);
    expect(saved.caption).not.toBe(reel().title);
    expect(mock.queue).toHaveBeenCalledOnce();
    // Renderer completion is external to this boundary test.
    const completed = { id: "export", ...saved, status: "SUCCEEDED", output: { videoKey: "private/result.mp4" } };
    mock.campaign.mockResolvedValue({ ...campaign(), outputs: [{ ...campaign().outputs[0], reel: { ...reel(), renderJobs: [completed] } }] });
    await expect(exportCampaignOutput(user, "campaign", "hero", 2, 0)).resolves.toBe("export");
    expect(mock.tx.renderJob.create).toHaveBeenCalledOnce();
    expect(mock.queue).toHaveBeenCalledOnce();
    mock.tx.renderJob.findFirst.mockResolvedValue(completed);
    await expect(createCampaignReview(user, "campaign", "output", "export")).resolves.toMatch(/^[A-Za-z0-9_-]{32}$/);
    const review = mock.tx.campaignReview.create.mock.calls[0][0].data;
    expect(review).toMatchObject({ exportId: "export", reelRevision: 2, factRevision: 0, caption: cut.caption });
    const state = { ...review, revokedAt: null, export: completed, output: { reelId: "hero", campaign: campaign(), reel: reel() } };
    expect(reviewCurrent(state)).toBe(true);
    expect(reviewCurrent({ ...state, output: { ...state.output, reel: { ...reel(), caption: "New copy" } } })).toBe(false);
    expect(reviewCurrent({ ...state, output: { ...state.output, reel: { ...reel(), revision: 3 } } })).toBe(false);
    expect(reviewCurrent({ ...state, output: { ...state.output, campaign: { ...campaign(), revision: 1 } } })).toBe(false);
  });

  it("keeps ordinary export labels unchanged", async () => {
    await expect(queueReelExport(user, "hero", { revision: 2 })).resolves.toEqual({ ok: true, jobId: "export" });
    expect(mock.tx.renderJob.create.mock.calls[0][0].data.caption).toBe(reel().title);
  });

  it("refuses a listing export when the reel changes before the locked commit", async () => {
    mock.tx.$queryRaw.mockResolvedValue([{ id: "locked", revision: 3 }]);
    await expect(exportCampaignOutput(user, "campaign", "hero", 2, 0)).rejects.toThrow(/changed after that edit/);
    expect(mock.tx.renderJob.create).not.toHaveBeenCalled();
    expect(mock.queue).not.toHaveBeenCalled();
  });
});
