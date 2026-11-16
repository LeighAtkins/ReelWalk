import { z } from "zod";
import { applyCommand } from "./commands";
import { clipDurationMs, clipStartsMs, keepTextsClearOfCard, listingDetailsSchema, parseTimeline, textSchema, timelineDurationMs, timelineSchema, type Timeline } from "./timeline";

export const CAMPAIGN_ROLES = ["hero", "teaser", "open-home"] as const;
export type CampaignRole = (typeof CAMPAIGN_ROLES)[number];
export const CAMPAIGN_ROLE_LABELS: Record<CampaignRole, string> = { hero: "Hero", teaser: "Teaser", "open-home": "Open home" };
export const campaignFactsSchema = listingDetailsSchema.omit({ placement: true }).extend({
  openHome: z.string().trim().min(1, "Add the verified open-home day and time.").max(60),
  disclosure: z.string().trim().min(1, "Keep source credits and AI disclosures with this campaign.").max(1200),
});
export type CampaignFacts = z.infer<typeof campaignFactsSchema>;
const OPEN_HOME_TEXT = "campaign-open-home";

export function campaignCaption(facts: CampaignFacts, role: CampaignRole): string {
  return [facts.address, facts.price, [facts.beds && `${facts.beds} beds`, facts.baths && `${facts.baths} baths`, facts.area].filter(Boolean).join(" · "), role === "open-home" && `Open home: ${facts.openHome}`, facts.contact, facts.disclosure].filter(Boolean).join("\n");
}

/** Only the details card, campaign-owned opener and generated caption are bound.
 * Footage, grades and customer-authored text remain editable and never regenerate. */
export function applyCampaignFacts(value: unknown, facts: CampaignFacts, role: CampaignRole): Timeline {
  const timeline = parseTimeline(value);
  if (!timeline.clips.length) throw new Error("Add footage to every campaign cut before applying shared details.");
  const firstMs = clipDurationMs(timeline.clips[0]);
  const details = listingDetailsSchema.parse({ ...facts, placement: timeline.details?.placement ?? "end" });
  const previous = timeline.texts.find((text) => text.id === OPEN_HOME_TEXT);
  const texts = timeline.texts.filter((text) => text.id !== OPEN_HOME_TEXT);
  if (role === "open-home") texts.push(textSchema.parse({
    ...previous, id: OPEN_HOME_TEXT, text: `Open home · ${facts.openHome}`, startMs: 0, endMs: firstMs,
    x: previous?.x ?? 0.5, y: previous?.y ?? 0.4, size: previous?.size ?? 0.75,
    style: "elegant", animation: "none", color: "#ffffff", shadow: "soft",
  }));
  return timelineSchema.parse(keepTextsClearOfCard({ ...timeline, details, texts }));
}

/** Teaser only shortens already accepted source windows. Never retime using the
 * full file length: a rejected tail may exist just beyond an accepted trim. */
export function buildListingCampaign(value: unknown, facts: CampaignFacts): { role: CampaignRole; timeline: Timeline; caption: string }[] {
  // Completed footage is reusable; paid operation/request identities belong to
  // the source shot board and must not be replayed from derived campaigns.
  const source = parseTimeline({ ...parseTimeline(value), shotBoard: undefined });
  if (!source.clips.length) throw new Error("Add accepted footage to the source reel first.");
  if (source.voiceover) throw new Error("Use a source cut without voiceover, then add narration separately to each campaign cut.");
  const teaser = source.clips.length > 5 ? source.clips.slice(0, 5) : source.clips;
  let short = { ...source };
  const context = { generation: 0, sourceDurationsMs: Object.fromEntries(source.clips.map((clip) => [clip.assetId, clip.sourceEndMs])) };
  const run = (command: Parameters<typeof applyCommand>[1]) => {
    const result = applyCommand(short, command, context);
    if (result.rejected) throw new Error(result.rejected);
    short = result.timeline;
  };
  for (const clip of source.clips) if (!teaser.some((kept) => kept.id === clip.id)) run({ type: "deleteClip", clipId: clip.id });
  for (const clip of teaser) {
    // Keep pano/complex shots intact: those have their own minimum motion duration.
    if (!clip.pano && !clip.ramp && clipDurationMs(clip) > 3000) {
      const speed = clip.kind === "IMAGE" ? 1 : clip.speed;
      run({ type: "trimClip", clipId: clip.id, window: { sourceStartMs: clip.sourceStartMs, sourceEndMs: Math.min(clip.sourceEndMs, clip.sourceStartMs + Math.round(3000 * speed)) } });
    }
  }
  // Branding follows the actual closing shot, for at least five seconds when available.
  const total = timelineDurationMs(short);
  const starts = clipStartsMs(short);
  const closingStart = starts[starts.length - 1] ?? 0;
  short = { ...short, texts: short.texts.map((text) => /made in reelwalk/i.test(text.text) ? { ...text, startMs: Math.min(closingStart, Math.max(0, total - 5000)), endMs: total } : text) };
  return CAMPAIGN_ROLES.map((role) => ({ role, timeline: applyCampaignFacts(role === "teaser" ? short : source, facts, role), caption: campaignCaption(facts, role) }));
}
