import type Stripe from "stripe";
import { AI_TOP_UP, type PlanId } from "@reelwalk/core";
import { lockBillingAccount, prisma } from "@reelwalk/db";
import { customerId, planForPrice, stripe } from "./stripe";

/**
 * The plan an invoice line bills. The line names its price by id and its product; the lookup key lives
 * on the price object, which the subscription's own items carry, so a price from before a currency swap
 * still resolves (ADR 0081).
 */
export function invoiceLinePlan(line: Stripe.InvoiceLineItem, subscription: Pick<Stripe.Subscription, "items">): PlanId | null {
  const details = line.pricing?.price_details;
  const price = details?.price;
  const id = typeof price === "string" ? price : price?.id;
  const full = typeof price === "object" ? price : subscription.items.data.find(item => item.price.id === id)?.price;
  return planForPrice({ id, lookup_key: full?.lookup_key, product: details?.product ?? full?.product });
}

/** Only a paid invoice can fund generation, even while export access is past_due. */
export async function applyAiInvoice(invoice: Stripe.Invoice, subscription: Stripe.Subscription) {
  if (invoice.status !== "paid" || !["active", "past_due"].includes(subscription.status)) return;
  const customer = customerId(subscription.customer);
  if (!customer) return;
  const workspace = await prisma.workspace.findUnique({ where: { stripeCustomerId: customer } });
  if (!workspace) throw new Error("Stripe invoice arrived before its workspace was linked.");
  // Validate the actual invoiced price. Reading the latest subscription alone
  // could fund a newly upgraded plan with an older, cheaper paid invoice.
  const line = invoice.lines.data.find(line => line.amount >= 0 && Boolean(invoiceLinePlan(line, subscription)));
  const plan = line ? invoiceLinePlan(line, subscription) : null;
  if (!line || !plan || plan === "FREE") return;
  const start = new Date(line.period.start * 1000);
  const end = new Date(line.period.end * 1000);
  if (end <= new Date()) return;
  await prisma.$transaction(async tx => {
    const current = await lockBillingAccount(tx, workspace.id);
    // Late invoices from an older subscription or period cannot replace newer access.
    if (current.stripeSubscriptionId && current.stripeSubscriptionId !== subscription.id) return;
    if (current.aiPaidThrough && current.aiPaidThrough > end) return;
    if (current.aiLastInvoiceCreated > invoice.created) return;
    // Keep the original anniversary when a prorated upgrade is paid mid-cycle.
    const anchor = current.aiPaidThrough?.getTime() === end.getTime() && current.aiPaidPeriodStart ? current.aiPaidPeriodStart : start;
    await tx.workspace.update({ where: { id: workspace.id }, data: { aiPaidPlan: plan, aiPaidPeriodStart: anchor, aiPaidThrough: end, aiLastInvoiceCreated: invoice.created } });
    await lockBillingAccount(tx, workspace.id);
  }, BILLING_TX);
}

export function aiTopUpPrice(): string | null {
  const value = process.env.STRIPE_PRICE_AI_TOP_UP;
  return value && value !== "unset" ? value : null;
}

// Stripe retries deliveries in bursts; a duplicate waits for the workspace lock instead of failing on
// Prisma's 2-second default for starting a transaction.
const BILLING_TX = { maxWait: 10_000, timeout: 15_000 };

/**
 * The A$19 price is GST-inclusive, so Stripe's total equals the subtotal and the GST is shown inside it;
 * a price set up tax-exclusive would add the tax on top. Both are the right amount; anything else is not.
 */
function topUpTotalMatches(session: Stripe.Checkout.Session): boolean {
  const tax = session.total_details?.amount_tax ?? 0;
  return session.amount_total === AI_TOP_UP.priceCents || session.amount_total === AI_TOP_UP.priceCents + tax;
}

/** Signed Stripe session + exact server-side price + unique source = one grant. */
export async function applyAiTopUp(session: Stripe.Checkout.Session) {
  if (session.mode !== "payment" || session.payment_status !== "paid" || session.metadata?.purpose !== "ai-top-up") return;
  const price = aiTopUpPrice();
  if (!price) throw new Error("AI top-up price is not configured.");
  const customer = customerId(session.customer);
  const workspaceId = session.client_reference_id;
  if (!customer || !workspaceId) throw new Error("Missing top-up customer.");
  const lines = await stripe().checkout.sessions.listLineItems(session.id, { limit: 2 });
  if (lines.data.length !== 1 || lines.data[0]?.price?.id !== price || lines.data[0]?.quantity !== 1 ||
    session.currency !== AI_TOP_UP.currency || session.amount_subtotal !== AI_TOP_UP.priceCents ||
    (session.total_details?.amount_discount ?? 0) !== 0 || !topUpTotalMatches(session)) throw new Error("Unexpected AI top-up purchase.");
  await prisma.$transaction(async tx => {
    const workspace = await lockBillingAccount(tx, workspaceId);
    if (workspace.stripeCustomerId !== customer) throw new Error("Top-up customer does not match workspace.");
    await tx.aiCreditGrant.upsert({ where: { source: `checkout:${session.id}` }, update: {}, create: {
      workspaceId, source: `checkout:${session.id}`, kind: "TOP_UP", amount: AI_TOP_UP.credits, remaining: AI_TOP_UP.credits,
    } });
  }, BILLING_TX);
}
