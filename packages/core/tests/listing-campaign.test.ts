import { describe, expect, it } from "vitest";
import { applyCampaignFacts, buildListingCampaign, campaignFactsSchema } from "../src/listing-campaign";
import { parseTimeline, timelineDurationMs } from "../src/timeline";
const facts = campaignFactsSchema.parse({ address: "Demo address", price: "Demo price", openHome: "Demo Saturday 2–4", disclosure: "Demonstration only. AI-generated motion from credited source images." });
const source = () => parseTimeline({ version: 1, clips: [
  { id: "accepted6", assetId: "take6", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 },
  { id: "accepted5", assetId: "take5", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3500 },
  { id: "accepted1", assetId: "take1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 },
], texts: [{ id: "brand", text: "Made in ReelWalk", startMs: 11500, endMs: 19500 }, { id: "author", text: "A custom note", startMs: 0, endMs: 8000 }], music: null });

describe("listing campaign from accepted footage", () => {
  it("makes three editable roles without mutating or extending any accepted source window", () => {
    const original = source(); const before = JSON.stringify(original);
    const cuts = buildListingCampaign(original, facts);
    expect(cuts.map((cut) => cut.role)).toEqual(["hero", "teaser", "open-home"]);
    expect(cuts[0].timeline.clips).toEqual(original.clips);
    expect(timelineDurationMs(cuts[1].timeline)).toBe(9000);
    for (const cut of cuts) for (const clip of cut.timeline.clips) {
      const accepted = original.clips.find((item) => item.id === clip.id)!;
      expect(clip.assetId).toBe(accepted.assetId);
      expect(clip.sourceStartMs).toBeGreaterThanOrEqual(accepted.sourceStartMs);
      expect(clip.sourceEndMs).toBeLessThanOrEqual(accepted.sourceEndMs);
    }
    expect(JSON.stringify(original)).toBe(before);
    const brand = cuts[1].timeline.texts.find((text) => text.id === "brand")!;
    expect(brand.endMs - brand.startMs).toBeGreaterThanOrEqual(5000);
    expect(cuts[2].timeline.texts.find((text) => text.id === "campaign-open-home")).toMatchObject({ startMs: 0, endMs: 8000, y: 0.4, animation: "none" });
  });
  it("changes only bound facts and keeps edited footage, styles and custom text", () => {
    const cut = buildListingCampaign(source(), facts)[2].timeline;
    cut.clips[0].filter = "warm";
    const updated = applyCampaignFacts(cut, { ...facts, price: "Revised demo price", openHome: "Demo Sunday 1–3" }, "open-home");
    expect(updated.clips).toEqual(cut.clips);
    expect(updated.texts.find((text) => text.id === "author")).toEqual(cut.texts.find((text) => text.id === "author"));
    expect(updated.details?.price).toBe("Revised demo price");
    expect(updated.texts.find((text) => text.id === "campaign-open-home")?.text).toContain("Demo Sunday 1–3");
  });
  it("requires verified event time and disclosures and refuses empty cuts", () => {
    expect(campaignFactsSchema.safeParse({ ...facts, openHome: "" }).success).toBe(false);
    expect(campaignFactsSchema.safeParse({ ...facts, disclosure: "" }).success).toBe(false);
    expect(() => buildListingCampaign({ ...source(), clips: [] }, facts)).toThrow(/footage/);
    expect(() => applyCampaignFacts({ ...source(), clips: [] }, facts, "hero")).toThrow(/footage/);
  });
  it("also works on another photo input and never copies source generation requests", () => {
    const photos = parseTimeline({ version: 1, clips: [{ id: "new-photo", assetId: "owner-photo", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 6000, motion: "zoom-in" }], texts: [], music: null,
      shotBoard: { version: 1, cards: [{ id: "source-card", clipId: "new-photo", request: { id: "source-paid-operation", draft: "Historical request only" } }] } });
    const cuts = buildListingCampaign(photos, facts);
    expect(cuts.map((cut) => cut.timeline.clips[0].assetId)).toEqual(["owner-photo", "owner-photo", "owner-photo"]);
    expect(cuts.every((cut) => cut.timeline.shotBoard === undefined)).toBe(true);
    expect(photos.shotBoard?.cards[0].request?.id).toBe("source-paid-operation");
  });
});
