import type Stripe from "stripe";
import type { PlanId } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { customerId, periodEnd, planForSubscription, stripe } from "./stripe";

/**
 * One way to bring a workspace's plan in line with Stripe (ADR 0088): read every subscription the
 * customer has and write what the one that governs access means. Webhook branches and the checkout
 * success page all call this, so an event that arrives late or out of order cannot leave a stale answer:
 * a `customer.subscription.deleted` for an old subscription, delivered after a new one went active,
 * re-reads the customer and finds the new one.
 */

const GOOD_STANDING: Stripe.Subscription.Status[] = ["active", "trialing", "past_due"];

/**
 * The subscription that should govern access, or null when the customer has none. First one that sells a
 * plan this app knows while in good standing (active, trialing, past_due), then any in good standing,
 * then anything; the newest wins among equals.
 */
export function governingSubscription<S extends Pick<Stripe.Subscription, "status" | "items" | "created">>(subscriptions: readonly S[]): S | null {
  const rank = (subscription: S) => (planForSubscription(subscription) !== "FREE" ? 2 : GOOD_STANDING.includes(subscription.status) ? 1 : 0);
  return [...subscriptions].sort((a, b) => rank(b) - rank(a) || b.created - a.created)[0] ?? null;
}

export type BillingSync = {
  workspaceId: string;
  plan: PlanId;
  /** The subscription that governs access, null when none does. */
  subscription: Stripe.Subscription | null;
  /** Every subscription the customer has, newest first. */
  subscriptions: Stripe.Subscription[];
};

/**
 * Re-reads a Stripe customer's subscriptions and writes plan, stripeSubscriptionId and planRenewsAt onto
 * its workspace, the same fields and meanings the per-subscription write had: Free clears the
 * subscription id and renewal date, the customer id is kept for the portal, and a comped plan
 * (compedPlan / compedUntil) is a separate field this never touches.
 *
 * The workspace is the one linked to the customer (checkout links it before payment); for a first
 * checkout that somehow is not, `workspaceHint` (the session's client_reference_id) and the
 * subscription's metadata.workspaceId find it. Returns null when no workspace matches.
 */
export async function syncWorkspaceBilling(customer: string, workspaceHint: string | null = null): Promise<BillingSync | null> {
  const subscriptions: Stripe.Subscription[] = [];
  // Newest first; a customer has a handful at most, but pages are followed rather than assumed.
  for await (const subscription of stripe().subscriptions.list({ customer, status: "all", limit: 100 })) subscriptions.push(subscription);
  subscriptions.sort((a, b) => b.created - a.created);
  const subscription = governingSubscription(subscriptions);
  const ids = subscriptions.map((s) => s.id);
  const workspace =
    (await prisma.workspace.findFirst({
      where: { OR: [{ stripeCustomerId: customer }, ...(ids.length ? [{ stripeSubscriptionId: { in: ids } }] : [])] },
      select: { id: true },
    })) ??
    (await prisma.workspace.findFirst({
      where: { id: subscriptions.map((s) => s.metadata?.workspaceId).find(Boolean) ?? workspaceHint ?? "" },
      select: { id: true },
    }));
  if (!workspace) {
    console.error(`stripe: no workspace for customer ${customer}`);
    return null;
  }
  const plan = subscription ? planForSubscription(subscription) : "FREE";
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      plan,
      stripeCustomerId: customerId(subscription?.customer) ?? customer,
      // Free clears the subscription; the customer id stays, so the portal link still works.
      stripeSubscriptionId: plan === "FREE" || !subscription ? null : subscription.id,
      planRenewsAt: plan === "FREE" || !subscription ? null : periodEnd(subscription),
    },
  });
  return { workspaceId: workspace.id, plan, subscription, subscriptions };
}
