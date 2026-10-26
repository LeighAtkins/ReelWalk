/**
 * What each plan allows. Shared by the web app (quotas, billing, the account
 * page, the landing page) and the worker (output size, watermark), so the
 * two never disagree.
 *
 * Prices are the one place the figures live, in two currencies (ADR 0085):
 * Australian dollars with GST included for visitors in Australia (ADR 0081),
 * US dollars plus applicable tax for everyone else. They must match the
 * Stripe prices, whose ids live in env (STRIPE_PRICE_<PLAN>_MONTHLY / _YEARLY,
 * and the same with _USD). The ids FREE/AGENT/OFFICE are
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

/** The currencies we charge in: A$ for Australia, US$ for everyone else (ADR 0085). */
export type Currency = "aud" | "usd";

export const CURRENCIES: Currency[] = ["aud", "usd"];

export function isCurrency(value: unknown): value is Currency {
  return value === "aud" || value === "usd";
}

/** Export width: 720 gives 720×1280, 1080 gives Instagram's full 1080×1920. */
export type OutputWidth = 720 | 1080;

export type PlanDef = {
  id: PlanId;
  name: string;
  /** Charged every month on the monthly plan, in A$ including GST. 0 for Free. */
  priceAud: number;
  /** Charged once a year on the yearly plan, in A$ including GST. 0 for Free. */
  priceAudYearly: number;
  /** Charged every month on the monthly plan, in US$ before tax. 0 for Free. */
  priceUsd: number;
  /** Charged once a year on the yearly plan, in US$ before tax. 0 for Free. */
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
  /** AI video credits (4 seconds each): a lifetime trial on Free, monthly on paid plans. */
  aiVideoCredits: number;
};

export const PLANS: Record<PlanId, PlanDef> = {
  FREE: { id: "FREE", name: "Free", priceAud: 0, priceAudYearly: 0, priceUsd: 0, priceUsdYearly: 0, exportsPerMonth: 3, exportsPerDay: 3, activeExports: 2, storageGb: 1, outputWidth: 720, watermark: true, instagram: false, seats: 1, aiEditsPerMonth: 5, aiVideoCredits: 2 },
  AGENT: { id: "AGENT", name: "Agent", priceAud: 39, priceAudYearly: 390, priceUsd: 29, priceUsdYearly: 290, exportsPerMonth: 40, exportsPerDay: 30, activeExports: 3, storageGb: 25, outputWidth: 1080, watermark: false, instagram: true, seats: 1, aiEditsPerMonth: 60, aiVideoCredits: 20 },
  OFFICE: { id: "OFFICE", name: "Studio", priceAud: 99, priceAudYearly: 990, priceUsd: 79, priceUsdYearly: 790, exportsPerMonth: 200, exportsPerDay: 100, activeExports: 6, storageGb: 100, outputWidth: 1080, watermark: false, instagram: true, seats: 5, aiEditsPerMonth: 300, aiVideoCredits: 60 },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

/** The next plan up, for "upgrade" links; null on the top plan. */
export function nextPlan(id: PlanId): PlanDef | null {
  return id === "FREE" ? PLANS.AGENT : id === "AGENT" ? PLANS.OFFICE : null;
}

/** What a plan costs for one charge at the given interval, in A$ unless another currency is named. */
export function planPrice(plan: PlanDef, interval: BillingInterval, currency: Currency = "aud"): number {
  if (currency === "usd") return interval === "year" ? plan.priceUsdYearly : plan.priceUsd;
  return interval === "year" ? plan.priceAudYearly : plan.priceAud;
}

/** The currency of a visitor nobody has placed yet: the site is Australian, but only Australians see A$. */
export const CURRENCY = "aud" as const;

/** The small print under any A$ price (Australian consumer law wants the total shown, not a price plus tax). */
export const PRICE_SMALL_PRINT = "Prices in Australian dollars. GST included where it applies.";

/** The small print under any US$ price: Stripe adds the tax that applies at checkout. */
export const PRICE_SMALL_PRINT_USD = "Prices in US dollars, plus applicable tax.";

export function priceSmallPrint(currency: Currency): string {
  return currency === "usd" ? PRICE_SMALL_PRINT_USD : PRICE_SMALL_PRINT;
}

/** How tax sits in a price, for the short line beside it: "GST included" or "plus tax". */
export function taxNote(currency: Currency): string {
  return currency === "usd" ? "plus tax" : "GST included";
}

/**
 * "A$39", "A$32.50": whole dollars when there are no cents. Always written with the A$ prefix so
 * it cannot be read as US dollars.
 */
export function formatAud(amount: number): string {
  const whole = Number.isInteger(amount);
  return `A$${amount.toLocaleString("en-AU", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "US$29", "US$24.17": the US$ prefix, so it cannot be read as Australian dollars either. */
export function formatUsd(amount: number): string {
  const whole = Number.isInteger(amount);
  return `US$${amount.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function formatCharge(amount: number, currency: Currency): string {
  return currency === "usd" ? formatUsd(amount) : formatAud(amount);
}

/** The yearly plan's price spread over twelve months, for "A$32.50 a month, billed yearly". */
export function yearlyPerMonth(plan: PlanDef, currency: Currency = "aud"): number {
  return Math.round((planPrice(plan, "year", currency) / 12) * 100) / 100;
}

/** How many months of the monthly price the yearly plan saves (two, at ten months' price). */
export function yearlyMonthsFree(plan: PlanDef): number {
  if (plan.priceAud === 0) return 0;
  return Math.round(12 - plan.priceAudYearly / plan.priceAud);
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
