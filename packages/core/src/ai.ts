export const AI_VIDEO_MODEL = "veo-3.1-fast-generate-001";

/** One credit buys 4 seconds of video: a 4-second clip costs 1 credit and an 8-second clip costs 2. */
export const AI_CLIP_SECONDS = [4, 8] as const;
export type AiClipSeconds = (typeof AI_CLIP_SECONDS)[number];
export const AI_SECONDS_PER_CREDIT = 4;
/** Veo 3.1 Fast, 1080p, silent: provider cost reserved per second generated. */
export const AI_COST_CENTS_PER_SECOND = 10;
/** A spoken line (ADR 0038): one credit on top of the clip, covering the voice and the lip-sync pass or Veo's audio. */
export const AI_VOICED_CREDITS = 1;
export const AI_VOICE_COST_CENTS_PER_SECOND = 5;
export const aiClipCredits = (seconds: AiClipSeconds, voiced = false) => seconds / AI_SECONDS_PER_CREDIT + (voiced ? AI_VOICED_CREDITS : 0);
export const aiClipCostCents = (seconds: AiClipSeconds, voiced = false) => seconds * (AI_COST_CENTS_PER_SECOND + (voiced ? AI_VOICE_COST_CENTS_PER_SECOND : 0));

/**
 * Draft tier (ADR 0076): a cheap, fast preview of a take. Veo 3.1 Lite at 720p, silent, from a starting frame (it takes
 * no ending frame). Reserved at $0.05 a second, Google's published Lite 720p rate; the silent Vertex rate may be lower.
 * Credits are whole numbers, so a draft is one credit whatever its length: the saving is on 8-second takes (1 against 2),
 * and a final made from a draft is charged what the full take costs less that credit (never less than one).
 */
export const AI_DRAFT_MODEL = "veo-3.1-lite-generate-001";
export const AI_DRAFT_COST_CENTS_PER_SECOND = 5;
export const AI_DRAFT_CREDITS = 1;
export const AI_DRAFT_NO_END_FRAME = "A draft is made from a starting frame only (Veo 3.1 Lite takes no ending frame). Generate the full take instead.";
export const aiDraftCostCents = (seconds: AiClipSeconds) => seconds * AI_DRAFT_COST_CENTS_PER_SECOND;
/** What the full take costs once a draft's credit is used toward it. */
export const aiFinalCredits = (seconds: AiClipSeconds, voiced: boolean, draftCredits: number) => Math.max(1, aiClipCredits(seconds, voiced) - draftCredits);
/**
 * Gemini Omni Flash (ADR 0105): Google's video model on the Gemini API, chosen per take beside Veo. Pay per second by
 * resolution; its 360p tier is the cheap draft a shot plan is made and checked in, and only a confirmed reel is made
 * again at 1080p (Google upscales from 720p; there is no upscaling an earlier take, so a final is a new take).
 */
export const AI_OMNI_MODEL = "gemini-omni-1.1-flash";
export const AI_OMNI_RESOLUTION = { draft: "360p", final: "1080p" } as const;
export const AI_OMNI_COST_CENTS_PER_SECOND = { "360p": 3, "720p": 10, "1080p": 15 } as const;
export const isOmniModel = (model: string) => model.startsWith("gemini-omni");
export const aiOmniCostCents = (seconds: AiClipSeconds, tier: "draft" | "final") => seconds * AI_OMNI_COST_CENTS_PER_SECOND[AI_OMNI_RESOLUTION[tier]];
/** The picture size a take of this model and tier is stored at (portrait). */
export function aiTakeSize(model: string, tier: "draft" | "final" | undefined): { width: number; height: number } {
  if (isOmniModel(model)) return tier === "draft" ? { width: 360, height: 640 } : { width: 1080, height: 1920 };
  return tier === "draft" ? { width: 720, height: 1280 } : { width: 1080, height: 1920 };
}

/** The resolution a model is asked for: the draft model's 720p, everything else 1080p. */
export const aiVideoResolution = (model: string) => (model === AI_DRAFT_MODEL ? "720p" : "1080p");

export const AI_TRIAL_CREDITS = 2;
export const AI_PLAN_CREDITS = { FREE: 2, AGENT: 20, OFFICE: 60 } as const;
/** 10 AI credits for A$19, GST included (cents of Australian dollars: the Stripe price must match). */
export const AI_TOP_UP = { priceCents: 1900, credits: 10, currency: "aud" } as const;
/** The same 10 credits for US$12 plus tax, for visitors outside Australia (ADR 0085). */
export const AI_TOP_UP_USD = { priceCents: 1200, credits: 10, currency: "usd" } as const;

/** The top-up as sold in a currency. */
export function aiTopUp(currency: "aud" | "usd"): typeof AI_TOP_UP | typeof AI_TOP_UP_USD {
  return currency === "usd" ? AI_TOP_UP_USD : AI_TOP_UP;
}

/** Monthly windows stay anchored to the subscription day, including Jan 31. */
export function aiCreditWindow(anchor: Date, paidThrough: Date, now = new Date()): { start: Date; end: Date } | null {
  if (now < anchor || now >= paidThrough) return null;
  const atMonth = (offset: number) => {
    const date = new Date(anchor);
    date.setUTCDate(1);
    date.setUTCMonth(anchor.getUTCMonth() + offset);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
    return date;
  };
  let offset = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  if (atMonth(offset) > now) offset -= 1;
  return { start: atMonth(offset), end: new Date(Math.min(atMonth(offset + 1).getTime(), paidThrough.getTime())) };
}
