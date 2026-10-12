import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { Prisma, prisma } from "@reelwalk/db";
import { appUrl } from "@/lib/app-url";
import { sendEmail, SUPPORT_EMAIL } from "@/lib/email";
import { customerId, isBillingConfigured, periodEnd, planForSubscription, stripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

/**
 * Stripe tells us here when a subscription starts, changes or ends. The
 * signature proves it is Stripe; the BillingEvent row makes a repeated
 * delivery harmless. The plan is always read back from the subscription
 * itself, never from the event's claims about it.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isBillingConfigured()) return NextResponse.json({ error: "billing is not configured" }, { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(await request.text(), signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  try {
    await prisma.billingEvent.create({ data: { id: event.id, type: event.type } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return NextResponse.json({ seen: true });
    throw error;
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (typeof session.subscription === "string") {
        const subscription = await stripe().subscriptions.retrieve(session.subscription);
        await applySubscription(subscription, session.client_reference_id);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await applySubscription(event.data.object, null);
      break;
    case "invoice.paid": {
      // A renewal: read the subscription back so the renewal date moves on.
      const subscriptionId = invoiceSubscriptionId(event.data.object);
      if (subscriptionId) await applySubscription(await stripe().subscriptions.retrieve(subscriptionId), null);
      break;
    }
    case "invoice.payment_failed":
      // Stripe retries on its own schedule; the customer hears from us once, with the portal link.
      await notifyPaymentFailed(event.data.object);
      break;
    case "charge.dispute.created":
    case "charge.refunded":
    case "radar.early_fraud_warning.created":
      // Money moved or is at risk: a person looks at these.
      await alertSupport(event);
      break;
    default:
      break;
  }
  return NextResponse.json({ ok: true });
}

/** Writes what a subscription currently means onto its workspace. */
async function applySubscription(subscription: Stripe.Subscription, workspaceHint: string | null): Promise<void> {
  const customer = customerId(subscription.customer);
  const workspace =
    (await prisma.workspace.findFirst({
      where: { OR: [{ stripeSubscriptionId: subscription.id }, ...(customer ? [{ stripeCustomerId: customer }] : [])] },
      select: { id: true },
    })) ??
    (await prisma.workspace.findFirst({ where: { id: subscription.metadata.workspaceId ?? workspaceHint ?? "" }, select: { id: true } }));
  if (!workspace) {
    console.error(`stripe: no workspace for subscription ${subscription.id}`);
    return;
  }
  const plan = planForSubscription(subscription);
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      plan,
      stripeCustomerId: customer ?? undefined,
      // A cancelled subscription's id is kept until a new one replaces it: the portal link still needs the customer.
      stripeSubscriptionId: plan === "FREE" ? null : subscription.id,
      planRenewsAt: plan === "FREE" ? null : periodEnd(subscription),
    },
  });
}

/** The subscription an invoice bills, if any (the API moved it under `parent`). */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  return typeof subscription === "string" ? subscription : subscription.id;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Tells the studio's first member that a renewal payment failed, with the portal link to fix the card. */
async function notifyPaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customer = customerId(invoice.customer);
  if (!customer) return;
  const workspace = await prisma.workspace.findFirst({
    where: { stripeCustomerId: customer },
    select: { name: true, users: { orderBy: { createdAt: "asc" }, take: 1, select: { email: true, name: true } } },
  });
  const owner = workspace?.users[0];
  if (!workspace || !owner) return;
  const amount = invoice.amount_due ? `$${(invoice.amount_due / 100).toFixed(2)}` : "the renewal";
  const link = `${await appUrl()}/account`;
  const text = `Hi ${owner.name},

The payment of ${amount} for ${workspace.name}'s ReelWalk plan did not go through. Stripe will try again over the next few days. To keep the plan, update the card here:

${link}

Nothing is lost if a retry fails: the studio goes back to the free plan and the reels stay.

ReelWalk`;
  const html = `<p>Hi ${escapeHtml(owner.name)},</p><p>The payment of ${escapeHtml(amount)} for ${escapeHtml(workspace.name)}'s ReelWalk plan did not go through. Stripe will try again over the next few days. To keep the plan, update the card:</p><p><a href="${escapeHtml(link)}">Manage billing</a></p><p>Nothing is lost if a retry fails: the studio goes back to the free plan and the reels stay.</p><p>ReelWalk</p>`;
  try {
    await sendEmail({ to: owner.email, subject: "Your ReelWalk payment did not go through", text, html });
  } catch (error) {
    console.error(`stripe: payment-failed email to ${owner.email} failed`, error);
  }
}

/** Disputes, refunds and fraud warnings go to a person, with enough to find the record in Stripe. */
async function alertSupport(event: Stripe.Event): Promise<void> {
  const object = event.data.object as { id?: string; amount?: number; currency?: string; charge?: string | { id: string }; reason?: string };
  const charge = typeof object.charge === "string" ? object.charge : object.charge?.id;
  const lines = [
    `Stripe event: ${event.type}`,
    `Object: ${object.id ?? "?"}`,
    charge ? `Charge: ${charge}` : null,
    object.amount != null ? `Amount: ${(object.amount / 100).toFixed(2)} ${(object.currency ?? "").toUpperCase()}` : null,
    object.reason ? `Reason: ${object.reason}` : null,
    `https://dashboard.stripe.com/${event.livemode ? "" : "test/"}events/${event.id}`,
  ].filter(Boolean) as string[];
  const text = lines.join("\n");
  try {
    await sendEmail({ to: SUPPORT_EMAIL, subject: `Stripe: ${event.type}`, text, html: `<pre>${escapeHtml(text)}</pre>` });
  } catch (error) {
    console.error("stripe: support alert failed", error, text);
  }
}
