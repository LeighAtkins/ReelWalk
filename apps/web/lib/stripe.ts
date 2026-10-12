import Stripe from "stripe";
import { BILLING_INTERVALS, type BillingInterval, type PlanId } from "@reelwalk/core";

/**
 * Stripe is optional: without keys the account page shows plans but no
 * upgrade buttons, and the webhook refuses everything. Keys come from SSM in
 * production (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) and the price ids
 * from plain env: one per plan and interval, STRIPE_PRICE_AGENT_MONTHLY,
 * STRIPE_PRICE_AGENT_YEARLY, STRIPE_PRICE_OFFICE_MONTHLY and
 * STRIPE_PRICE_OFFICE_YEARLY. The monthly prices are required for billing to
 * be on; a missing yearly price just hides the yearly option.
 */
export function isBillingConfigured(): boolean {
  return ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", ...PAID.map((plan) => priceEnvName(plan, "month"))].every(isSet);
}

// Terraform stores an absent secret as "unset" (Parameter Store refuses empty values).
const isSet = (name: string) => Boolean(process.env[name]) && process.env[name] !== "unset";

let client: Stripe | null = null;

export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  client ??= new Stripe(key, { appInfo: { name: "ReelWalk", url: "https://reelwalking.com" } });
  return client;
}

const PAID: Exclude<PlanId, "FREE">[] = ["AGENT", "OFFICE"];

/** The env var holding the Stripe price id for a plan at an interval. */
export function priceEnvName(plan: Exclude<PlanId, "FREE">, interval: BillingInterval): string {
  return `STRIPE_PRICE_${plan}_${interval === "year" ? "YEARLY" : "MONTHLY"}`;
}

export function priceForPlan(plan: PlanId, interval: BillingInterval = "month"): string | null {
  if (plan === "FREE") return null;
  const id = process.env[priceEnvName(plan, interval)];
  return id && id !== "unset" ? id : null;
}

/** Whether every paid plan can be bought at this interval (yearly prices may be left out). */
export function isIntervalAvailable(interval: BillingInterval): boolean {
  return PAID.every((plan) => priceForPlan(plan, interval) !== null);
}

/** The plan a Stripe price id sells, or null for a price this app does not know. */
export function planForPrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  return PAID.find((plan) => BILLING_INTERVALS.some((interval) => priceForPlan(plan, interval) === priceId)) ?? null;
}

/**
 * What a subscription means for the workspace: its plan while Stripe
 * considers it in good standing (past_due keeps access through the retry
 * window), Free once it is cancelled, unpaid or paused.
 */
export function planForSubscription(subscription: Pick<Stripe.Subscription, "status" | "items">): PlanId {
  const inGoodStanding = subscription.status === "active" || subscription.status === "trialing" || subscription.status === "past_due";
  if (!inGoodStanding) return "FREE";
  return planForPrice(subscription.items.data[0]?.price.id) ?? "FREE";
}

/** When the current billing period ends; Stripe moved this onto the items. */
export function periodEnd(subscription: Pick<Stripe.Subscription, "items">): Date | null {
  const end = subscription.items.data[0]?.current_period_end;
  return end ? new Date(end * 1000) : null;
}

export function customerId(value: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}
