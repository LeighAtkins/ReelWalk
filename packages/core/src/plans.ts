/**
 * What each plan allows. Shared by the web app (quotas, billing, the account
 * page) and the worker (output size, watermark), so the two never disagree.
 *
 * Prices are what Stripe charges; the price ids live in env (STRIPE_PRICE_*).
 */

export type PlanId = "FREE" | "AGENT" | "OFFICE";

/** Export width: 720 gives 720×1280, 1080 gives Instagram's full 1080×1920. */
export type OutputWidth = 720 | 1080;

export type PlanDef = {
  id: PlanId;
  name: string;
  priceUsd: number;
  /** Exports started in a calendar month (UTC). Failed renders do not count. */
  exportsPerMonth: number;
  /** Exports queued or rendering at once. */
  activeExports: number;
  storageGb: number;
  outputWidth: OutputWidth;
  watermark: boolean;
  /** One-tap posting to Instagram. */
  instagram: boolean;
  seats: number;
};

export const PLANS: Record<PlanId, PlanDef> = {
  FREE: { id: "FREE", name: "Free", priceUsd: 0, exportsPerMonth: 5, activeExports: 2, storageGb: 1, outputWidth: 720, watermark: true, instagram: false, seats: 1 },
  AGENT: { id: "AGENT", name: "Agent", priceUsd: 19, exportsPerMonth: 50, activeExports: 3, storageGb: 25, outputWidth: 1080, watermark: false, instagram: true, seats: 1 },
  OFFICE: { id: "OFFICE", name: "Office", priceUsd: 79, exportsPerMonth: 300, activeExports: 6, storageGb: 100, outputWidth: 1080, watermark: false, instagram: true, seats: 5 },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

/**
 * The plan a workspace is on right now. A paid plan wins; otherwise a plan
 * given by hand (testers, goodwill) counts until its date; otherwise Free.
 */
export function effectivePlan(
  workspace: { plan: PlanId; compedPlan: PlanId | null; compedUntil: Date | null },
  now: Date = new Date(),
): PlanId {
  if (workspace.plan !== "FREE") return workspace.plan;
  if (workspace.compedPlan && workspace.compedUntil && workspace.compedUntil.getTime() > now.getTime()) return workspace.compedPlan;
  return "FREE";
}

/** The first moment of the current calendar month, UTC: the export allowance resets here. */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Frame size of an export: 9:16 at the given width. */
export function outputSize(width: OutputWidth): { width: number; height: number } {
  return { width, height: (width * 16) / 9 };
}
