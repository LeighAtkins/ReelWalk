"use server";

import { redirect } from "next/navigation";
import { isPlanId } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { appUrl } from "@/lib/app-url";
import { isBillingConfigured, priceForPlan, stripe } from "@/lib/stripe";
import { getCurrentUser } from "@/lib/workspace";

/** The Stripe customer for this workspace, created on first use. */
async function customerFor(workspaceId: string, email: string, name: string): Promise<string> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { stripeCustomerId: true } });
  if (workspace.stripeCustomerId) return workspace.stripeCustomerId;
  const customer = await stripe().customers.create({ email, name, metadata: { workspaceId } });
  await prisma.workspace.update({ where: { id: workspaceId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

/** Sends the signed-in user to Stripe Checkout for a plan. The webhook sets the plan once paid. */
export async function startCheckout(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const plan = formData.get("plan");
  if (!isBillingConfigured() || !isPlanId(plan) || plan === "FREE") redirect("/account?billing=unavailable");
  const base = await appUrl();
  const customer = await customerFor(user.workspaceId, user.email, user.workspace.name);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: priceForPlan(plan)!, quantity: 1 }],
    client_reference_id: user.workspaceId,
    subscription_data: { metadata: { workspaceId: user.workspaceId } },
    allow_promotion_codes: true,
    success_url: `${base}/account?billing=welcome`,
    cancel_url: `${base}/account`,
  });
  if (!session.url) redirect("/account?billing=unavailable");
  redirect(session.url);
}

/** Stripe's own page for changing card, plan or cancelling. */
export async function openBillingPortal(): Promise<void> {
  const user = await getCurrentUser();
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId }, select: { stripeCustomerId: true } });
  if (!isBillingConfigured() || !workspace.stripeCustomerId) redirect("/account?billing=unavailable");
  const base = await appUrl();
  const session = await stripe().billingPortal.sessions.create({ customer: workspace.stripeCustomerId, return_url: `${base}/account` });
  redirect(session.url);
}
