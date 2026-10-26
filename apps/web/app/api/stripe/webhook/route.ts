import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { Prisma, prisma } from "@reelwalk/db";
import { appUrl } from "@/lib/app-url";
import { sendEmail, SUPPORT_EMAIL } from "@/lib/email";
import { recordFunnelEvent } from "@/lib/funnel";
import { env } from "@/env";
import { customerId, invoiceAmount, isBillingConfigured, planForSubscription, stripe } from "@/lib/stripe";
import { applyAiInvoice, applyAiTopUp } from "@/lib/billing-ai";
import { syncWorkspaceBilling } from "@/lib/billing-sync";

export const dynamic = "force-dynamic";

/**
 * Stripe tells us here when a subscription starts, changes or ends. The
 * signature proves it is Stripe; the BillingEvent row makes a repeated
 * delivery harmless. The plan is always read back from Stripe, never from
 * the event's claims: every subscription change re-reads all of the
 * customer's subscriptions (ADR 0088), so events arriving late or out of
 * order cannot leave a stale plan.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isBillingConfigured()) return NextResponse.json({ error: "billing is not configured" }, { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(await request.text(), signature, env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  if (await prisma.billingEvent.findUnique({ where: { id: event.id } })) return NextResponse.json({ seen: true });

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      await applyAiTopUp(session);
      if (typeof session.subscription === "string") {
        const customer = customerId(session.customer);
        const synced = customer ? await syncWorkspaceBilling(customer, session.client_reference_id) : null;
        const subscription = synced?.subscriptions.find((s) => s.id === session.subscription) ?? (await stripe().subscriptions.retrieve(session.subscription));
        const workspaceId = synced?.workspaceId ?? null;
        // The first paid checkout of a subscription, once however often Stripe redelivers (ADR 0080).
        // Amounts are in cents, as Stripe sends them; the subtotal is before tax, which is what the ad platforms want as "value".
        await recordFunnelEvent({
          name: "subscribed",
          workspaceId,
          key: `subscribed:${subscription.id}`,
          data: {
            plan: planForSubscription(subscription),
            interval: subscription.items.data[0]?.price.recurring?.interval ?? null,
            subtotal: session.amount_subtotal ?? null,
            total: session.amount_total ?? null,
            currency: session.currency ?? null,
          },
        });
      }
      break;
    }
    // Any change to a subscription re-reads all of the customer's (ADR 0088). The live endpoint does not
    // send paused/resumed/pending_update_* today; they need no code if they are added.
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    case "customer.subscription.pending_update_applied":
    case "customer.subscription.pending_update_expired": {
      const customer = customerId(event.data.object.customer);
      if (customer) await syncWorkspaceBilling(customer, event.data.object.metadata?.workspaceId ?? null);
      break;
    }
    case "checkout.session.async_payment_succeeded":
      await applyAiTopUp(event.data.object);
      break;
    case "invoice.paid": {
      // A renewal: read the subscription back so the renewal date moves on.
      const subscriptionId = invoiceSubscriptionId(event.data.object);
      if (subscriptionId) {
        // The subscription this invoice billed, which is what funds AI credits (applyAiInvoice checks it still governs).
        const subscription = await stripe().subscriptions.retrieve(subscriptionId);
        const customer = customerId(subscription.customer);
        if (customer) await syncWorkspaceBilling(customer, subscription.metadata?.workspaceId ?? null);
        await applyAiInvoice(event.data.object, subscription);
      }
      break;
    }
    case "invoice.payment_action_required":
      // Not subscribed on the live endpoint today: a payment waiting on 3-D Secure moves the subscription's status.
      if (invoiceSubscriptionId(event.data.object)) {
        const customer = customerId(event.data.object.customer);
        if (customer) await syncWorkspaceBilling(customer);
      }
      break;
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
  // Record completion after processing. A crash/failure must remain retryable.
  // Grants and plan writes are idempotent even on concurrent redelivery.
  try {
    await prisma.billingEvent.create({ data: { id: event.id, type: event.type } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }
  return NextResponse.json({ ok: true });
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
  const amount = invoice.amount_due ? invoiceAmount(invoice.amount_due, invoice.currency) : "the renewal";
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
