import { prisma } from "@reelwalk/db";
import { applyAiTopUp } from "./billing-ai";
import { syncWorkspaceBilling } from "./billing-sync";
import { customerId, isBillingConfigured, stripe } from "./stripe";

/** How long the account page waits for Stripe before showing the "within a few seconds" message instead. */
const RETURN_TIMEOUT_MS = 5000;

const SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;

/**
 * When Checkout sends someone back to the account page (ADR 0088), bring the workspace up to date before
 * the page renders instead of waiting for the webhook: `welcome` re-syncs the plan, `credits` grants a paid
 * top-up through the same idempotent grant the webhook uses, so whichever arrives second does nothing.
 *
 * The session id in the URL only says which checkout to look at; nothing in it is trusted. The session must
 * belong to the workspace's own Stripe customer, or it is ignored. Returns true only when the change is
 * confirmed (a paid plan is in place, or the credits are granted); false on anything else, including Stripe
 * being slow or failing, in which case the page shows today's message and the webhook still does the work.
 */
export async function confirmCheckoutReturn(workspaceId: string, sessionId: string | undefined, kind: "welcome" | "credits"): Promise<boolean> {
  if (!sessionId || !SESSION_ID.test(sessionId) || !isBillingConfigured()) return false;
  const work = confirm(workspaceId, sessionId, kind).catch((error: unknown) => {
    console.error(`stripe: checkout return ${sessionId} not confirmed`, error);
    return false;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), RETURN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function confirm(workspaceId: string, sessionId: string, kind: "welcome" | "credits"): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { stripeCustomerId: true } });
  if (!workspace?.stripeCustomerId) return false;
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  if (customerId(session.customer) !== workspace.stripeCustomerId) return false;
  if (kind === "welcome") {
    if (session.mode !== "subscription") return false;
    const synced = await syncWorkspaceBilling(workspace.stripeCustomerId, workspaceId);
    return synced?.workspaceId === workspaceId && synced.plan !== "FREE";
  }
  if (session.mode !== "payment" || session.metadata?.purpose !== "ai-top-up" || session.payment_status !== "paid" || session.client_reference_id !== workspaceId) return false;
  await applyAiTopUp(session);
  return true;
}
