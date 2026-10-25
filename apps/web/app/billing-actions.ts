"use server";

import { redirect } from "next/navigation";
import { isBillingInterval, isPlanId } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { appUrl } from "@/lib/app-url";
import { isBillingConfigured, priceForPlan, stripe } from "@/lib/stripe";
import { canManage } from "@/lib/workspace-access";
import { getCurrentUser } from "@/lib/workspace";
import { aiTopUpPrice } from "@/lib/billing-ai";

/** The Stripe customer for this workspace, created on first use. */
async function customerFor(workspaceId: string, email: string, name: string): Promise<string> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { stripeCustomerId: true } });
  if (workspace.stripeCustomerId) return workspace.stripeCustomerId;
  const customer = await stripe().customers.create({ email, name, metadata: { workspaceId } }, { idempotencyKey: `customer:${workspaceId}` });
  await prisma.workspace.update({ where: { id: workspaceId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

/**
 * Sends the signed-in user to Stripe Checkout for a plan, charged monthly
 * (the default) or yearly when the form says `interval=year`. The webhook
 * sets the plan once paid.
 */
export async function startCheckout(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!canManage(user.role)) redirect("/account?billing=unavailable");
  // Existing subscribers change plans in the portal rather than creating a
  // second subscription with a second monthly charge.
  if (user.workspace.stripeSubscriptionId) return openBillingPortal();
  const plan = formData.get("plan");
  const interval = formData.get("interval") ?? "month";
  if (!isBillingConfigured() || !isPlanId(plan) || plan === "FREE" || !isBillingInterval(interval)) redirect("/account?billing=unavailable");
  const price = priceForPlan(plan, interval);
  if (!price) redirect("/account?billing=unavailable");
  const base = await appUrl();
  const customer = await customerFor(user.workspaceId, user.email, user.workspace.name);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.workspaceId,
    subscription_data: { metadata: { workspaceId: user.workspaceId } },
    allow_promotion_codes: true,
    // Offices get a proper invoice: Checkout asks for the billing address and
    // an optional tax id, and writes both onto the customer.
    billing_address_collection: "auto",
    tax_id_collection: { enabled: true },
    customer_update: { name: "auto", address: "auto" },
    // Tags the session in the Dashboard so this flow can be told apart from later ones.
    integration_identifier: "reelwalk_plan_checkout_qmxvtkhe",
    success_url: `${base}/account?billing=welcome`,
    cancel_url: `${base}/account`,
  });
  if (!session.url) redirect("/account?billing=unavailable");
  redirect(session.url);
}

/** One-off credits do not expire with a monthly allowance. */
export async function buyAiCredits(): Promise<void> {
  const user = await getCurrentUser();
  // Owners pay, and there is nothing to buy credits for in a workspace with AI off (ADR 0079).
  if (!canManage(user.role) || user.workspace.aiGeneration === "off") redirect("/account?billing=unavailable");
  const price = aiTopUpPrice();
  if (!isBillingConfigured() || !price || user.email === "demo@reelwalk.local") redirect("/account?billing=unavailable");
  const customer = await customerFor(user.workspaceId, user.email, user.workspace.name);
  const base = await appUrl();
  const session = await stripe().checkout.sessions.create({
    mode: "payment", customer, line_items: [{ price, quantity: 1 }], client_reference_id: user.workspaceId,
    metadata: { purpose: "ai-top-up", workspaceId: user.workspaceId },
    success_url: `${base}/account?billing=credits`, cancel_url: `${base}/account`,
  });
  if (!session.url) redirect("/account?billing=unavailable");
  redirect(session.url);
}

/** Stripe's own page for changing card, plan or cancelling. */
export async function openBillingPortal(): Promise<void> {
  const user = await getCurrentUser();
  if (!canManage(user.role)) redirect("/account?billing=unavailable");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId }, select: { stripeCustomerId: true } });
  if (!isBillingConfigured() || !workspace.stripeCustomerId) redirect("/account?billing=unavailable");
  const base = await appUrl();
  const session = await stripe().billingPortal.sessions.create({ customer: workspace.stripeCustomerId, return_url: `${base}/account` });
  redirect(session.url);
}
