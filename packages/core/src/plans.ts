/**
 * What each plan allows. Shared by the web app (quotas, billing, the account
 * page, the landing page) and the worker (output size, watermark), so the
 * two never disagree.
 *
 * Prices are what Stripe charges; the price ids live in env
 * (STRIPE_PRICE_<PLAN>_MONTHLY / _YEARLY). The ids FREE/AGENT/OFFICE are
 * stored in the database, so a plan may be renamed (OFFICE shows as "Studio")
 * without a migration.
 */

export type PlanId = "FREE" | "AGENT" | "OFFICE";

/** How often a paid plan is charged. Yearly costs ten months: two free. */
export type BillingInterval = "month" | "year";

export const BILLING_INTERVALS: BillingInterval[] = ["month", "year"];

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}

/** Export width: 720 gives 720×1280, 1080 gives Instagram's full 1080×1920. */
export type OutputWidth = 720 | 1080;

export type PlanDef = {
  id: PlanId;
  name: string;
  /** Charged every month on the monthly plan. 0 for Free. */
  priceUsd: number;
  /** Charged once a year on the yearly plan. 0 for Free. */
  priceUsdYearly: number;
  /** Exports started in a calendar month (UTC). Failed renders do not count. */
  exportsPerMonth: number;
  /** Exports started in any 24 hours: keeps one account from running up the render bill in an afternoon. */
  exportsPerDay: number;
  /** Exports queued or rendering at once. */
  activeExports: number;
  storageGb: number;
  outputWidth: OutputWidth;
  watermark: boolean;
  /** One-tap posting to Instagram. */
  instagram: boolean;
  seats: number;
  /** Changes asked for in words (ADR 0020), in a calendar month. Re-exports count as exports. */
  aiEditsPerMonth: number;
  /** Eight-second AI video clips: one lifetime trial, monthly on paid plans. */
  aiVideoClips: number;
};

export const PLANS: Record<PlanId, PlanDef> = {
  FREE: { id: "FREE", name: "Free", priceUsd: 0, priceUsdYearly: 0, exportsPerMonth: 3, exportsPerDay: 3, activeExports: 2, storageGb: 1, outputWidth: 720, watermark: true, instagram: false, seats: 1, aiEditsPerMonth: 5, aiVideoClips: 1 },
  AGENT: { id: "AGENT", name: "Agent", priceUsd: 29, priceUsdYearly: 290, exportsPerMonth: 40, exportsPerDay: 30, activeExports: 3, storageGb: 25, outputWidth: 1080, watermark: false, instagram: true, seats: 1, aiEditsPerMonth: 60, aiVideoClips: 10 },
  OFFICE: { id: "OFFICE", name: "Studio", priceUsd: 79, priceUsdYearly: 790, exportsPerMonth: 200, exportsPerDay: 100, activeExports: 6, storageGb: 100, outputWidth: 1080, watermark: false, instagram: true, seats: 5, aiEditsPerMonth: 300, aiVideoClips: 30 },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

/** The next plan up, for "upgrade" links; null on the top plan. */
export function nextPlan(id: PlanId): PlanDef | null {
  return id === "FREE" ? PLANS.AGENT : id === "AGENT" ? PLANS.OFFICE : null;
}

/** What a plan costs for one charge at the given interval. */
export function planPrice(plan: PlanDef, interval: BillingInterval): number {
  return interval === "year" ? plan.priceUsdYearly : plan.priceUsd;
}

/** The yearly plan's price spread over twelve months, for "$24/month, billed yearly". */
export function yearlyPerMonth(plan: PlanDef): number {
  return Math.round((plan.priceUsdYearly / 12) * 100) / 100;
}

/** How many months of the monthly price the yearly plan saves (two, at ten months' price). */
export function yearlyMonthsFree(plan: PlanDef): number {
  if (plan.priceUsd === 0) return 0;
  return Math.round(12 - plan.priceUsdYearly / plan.priceUsd);
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
