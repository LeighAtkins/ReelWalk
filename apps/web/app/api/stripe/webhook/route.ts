import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { Prisma, prisma } from "@reelwalk/db";
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
