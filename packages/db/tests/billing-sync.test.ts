import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { aiCreditSummary, prisma } from "../src";
const mocks = vi.hoisted(() => ({ list: vi.fn(), retrieveSession: vi.fn(), listLineItems: vi.fn() }));
vi.mock("../../../apps/web/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../apps/web/lib/stripe")>()),
  isBillingConfigured: () => true,
  stripe: () => ({
    subscriptions: { list: mocks.list },
    checkout: { sessions: { retrieve: mocks.retrieveSession, listLineItems: mocks.listLineItems } },
  }),
}));
import { applyAiTopUp } from "../../../apps/web/lib/billing-ai";
import { confirmCheckoutReturn } from "../../../apps/web/lib/billing-return";
import { syncWorkspaceBilling } from "../../../apps/web/lib/billing-sync";

// ADR 0088: the plan follows the customer's subscriptions as a whole, and the success page's eager grant
// and the webhook's grant are one grant.
describe.skipIf(!process.env.DATABASE_URL)("Stripe customer sync (Postgres)", () => {
  const ids: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  process.env.STRIPE_PRICE_AGENT_MONTHLY = "price-agent";
  process.env.STRIPE_PRICE_OFFICE_MONTHLY = "price-studio";
  async function studio(subscription: string | null = null) {
    const workspace = await prisma.workspace.create({ data: {
      name: "Billing sync test", slug: `billing-sync-${randomUUID()}`, stripeCustomerId: `cus_${randomUUID()}`,
      stripeSubscriptionId: subscription, plan: subscription ? "AGENT" : "FREE",
      users: { create: { email: `${randomUUID()}@example.test`, name: "Tester" } },
    } }); ids.push(workspace.id); return workspace;
  }
  const sub = (id: string, customer: string, status: string, created: number, price = "price-agent") =>
    ({ id, customer, status, created, metadata: {}, items: { data: [{ price: { id: price }, current_period_end: now + 30 * 86400 }] } });
  const listing = (subscriptions: unknown[]) => ({ async *[Symbol.asyncIterator]() { yield* subscriptions; } });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
    for (const name of ["STRIPE_PRICE_AGENT_MONTHLY", "STRIPE_PRICE_OFFICE_MONTHLY", "STRIPE_PRICE_AI_TOP_UP"]) delete process.env[name];
    await prisma.$disconnect();
  });

  it("a late deleted event for the old subscription leaves a customer with a new active one on their paid plan", async () => {
    const w = await studio("sub_old");
    // The new subscription is already active when `customer.subscription.deleted` for sub_old is handled.
    mocks.list.mockReturnValue(listing([sub("sub_new", w.stripeCustomerId!, "active", now, "price-studio"), sub("sub_old", w.stripeCustomerId!, "canceled", now - 86400)]));
    await syncWorkspaceBilling(w.stripeCustomerId!);
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: w.id } });
    expect(after).toMatchObject({ plan: "OFFICE", stripeSubscriptionId: "sub_new", stripeCustomerId: w.stripeCustomerId });
    expect(after.planRenewsAt?.getTime()).toBe((now + 30 * 86400) * 1000);
  });

  it("the success page's grant and the later webhook's grant add the credits once", async () => {
    const w = await studio(); process.env.STRIPE_PRICE_AI_TOP_UP = "price-top-up";
    mocks.listLineItems.mockResolvedValue({ data: [{ price: { id: "price-top-up" }, quantity: 1 }] });
    const session = { id: `cs_test_${randomUUID().replace(/-/g, "")}`, mode: "payment", payment_status: "paid", metadata: { purpose: "ai-top-up" }, currency: "aud",
      amount_subtotal: 1900, amount_total: 1900, customer: w.stripeCustomerId, client_reference_id: w.id };
    mocks.retrieveSession.mockResolvedValue(session);
    expect(await confirmCheckoutReturn(w.id, session.id, "credits")).toBe(true);
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(10);
    // checkout.session.completed arrives after the page already granted.
    await applyAiTopUp(session as unknown as Parameters<typeof applyAiTopUp>[0]);
    expect(await confirmCheckoutReturn(w.id, session.id, "credits")).toBe(true);
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(10);
  });
});
