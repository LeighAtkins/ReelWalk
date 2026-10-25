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
 *
 * Prices are Australian dollars (ADR 0081). A subscription bought before the
 * swap still carries its old USD price id, so a price that is not one of the
 * env ids is also recognised by its lookup key (agent_monthly_aud, ...) and by
 * its product (STRIPE_PRODUCT_AGENT / STRIPE_PRODUCT_OFFICE, optional).
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

/** What identifies a Stripe price: its id, and when the object is at hand its lookup key and product. */
export type PriceRef = { id?: string | null; lookup_key?: string | null; product?: string | { id: string } | null };

/** The lookup keys the AUD prices are created with; the plan they sell. */
export const PRICE_LOOKUP_KEYS: Record<string, Exclude<PlanId, "FREE">> = {
  agent_monthly_aud: "AGENT",
  agent_yearly_aud: "AGENT",
  office_monthly_aud: "OFFICE",
  office_yearly_aud: "OFFICE",
};

/** The env var holding a plan's Stripe product id (optional): its prices in any currency sell that plan. */
export function productEnvName(plan: Exclude<PlanId, "FREE">): string {
  return `STRIPE_PRODUCT_${plan}`;
}

/**
 * The plan a Stripe price sells, or null for a price this app does not know. Matches, in order: the
 * price id against the env ids, then its lookup key, then its product. Pass the price object (a
 * subscription item has it) so a price replaced by a currency swap still resolves; a bare id only
 * matches the env ids.
 */
export function planForPrice(price: string | PriceRef | null | undefined): PlanId | null {
  if (!price) return null;
  const ref: PriceRef = typeof price === "string" ? { id: price } : price;
  if (ref.id) {
    const byId = PAID.find((plan) => BILLING_INTERVALS.some((interval) => priceForPlan(plan, interval) === ref.id));
    if (byId) return byId;
  }
  if (ref.lookup_key && Object.hasOwn(PRICE_LOOKUP_KEYS, ref.lookup_key)) return PRICE_LOOKUP_KEYS[ref.lookup_key];
  const product = typeof ref.product === "string" ? ref.product : ref.product?.id;
  if (product) {
    return (
      PAID.find((plan) => {
        const id = process.env[productEnvName(plan)];
        return Boolean(id) && id !== "unset" && id === product;
      }) ?? null
    );
  }
  return null;
}

/**
 * What a subscription means for the workspace: its plan while Stripe
 * considers it in good standing (past_due keeps access through the retry
 * window), Free once it is cancelled, unpaid or paused.
 */
export function planForSubscription(subscription: Pick<Stripe.Subscription, "status" | "items">): PlanId {
  const inGoodStanding = subscription.status === "active" || subscription.status === "trialing" || subscription.status === "past_due";
  if (!inGoodStanding) return "FREE";
  // The whole price, not just its id: a price from before a currency swap resolves by lookup key or product.
  return planForPrice(subscription.items.data[0]?.price) ?? "FREE";
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
