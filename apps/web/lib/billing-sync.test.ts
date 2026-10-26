import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stripe and the database are stubbed: these tests are about which subscription wins and what is written.
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  retrieveSession: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  applyAiTopUp: vi.fn(),
}));
vi.mock("@reelwalk/db", () => ({
  prisma: { workspace: { findFirst: mocks.findFirst, findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock("./billing-ai", () => ({ applyAiTopUp: mocks.applyAiTopUp }));
vi.mock("./stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stripe")>();
  return {
    ...actual,
    isBillingConfigured: () => true,
    stripe: () => ({ subscriptions: { list: mocks.list }, checkout: { sessions: { retrieve: mocks.retrieveSession } } }),
  };
});

import { governingSubscription, syncWorkspaceBilling } from "./billing-sync";
import { confirmCheckoutReturn } from "./billing-return";

const PRICES = { STRIPE_PRICE_AGENT_MONTHLY: "price_agent_m", STRIPE_PRICE_OFFICE_MONTHLY: "price_office_m" };
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(PRICES).map((name) => [name, process.env[name]]));
  Object.assign(process.env, PRICES);
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.update.mockResolvedValue({});
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Sub = { id: string; customer: string; status: string; created: number; metadata: Record<string, string>; items: { data: { price: { id: string }; current_period_end: number }[] } };
const sub = (id: string, status: string, created: number, price = "price_agent_m"): Sub => ({
  id, customer: "cus_1", status, created, metadata: {}, items: { data: [{ price: { id: price }, current_period_end: created + 30 * 86400 }] },
});
/** What `stripe.subscriptions.list` returns: an auto-paginating list, here a plain async iterable. */
const listing = (subscriptions: Sub[]) => ({ async *[Symbol.asyncIterator]() { yield* subscriptions; } });

/** The picker over the test's plain objects. */
const pick = (subscriptions: Sub[]) => governingSubscription(subscriptions as never[]) as Sub | null;

describe("governingSubscription", () => {
  it("prefers a paid plan in good standing over a newer cancelled or incomplete one", () => {
    const active = sub("sub_active", "active", 100);
    expect(pick([sub("sub_new", "incomplete", 300), sub("sub_gone", "canceled", 200), active])).toBe(active);
  });

  it("keeps past_due and trialing in good standing, newest first among equals", () => {
    expect(pick([sub("a", "past_due", 100), sub("b", "trialing", 200)])?.id).toBe("b");
  });

  it("prefers a subscription selling a known plan over one with an unknown price", () => {
    expect(pick([sub("odd", "active", 300, "price_other"), sub("plan", "active", 100)])?.id).toBe("plan");
  });

  it("is the newest of the rest when nothing is in good standing, and null for no subscriptions", () => {
    expect(pick([sub("old", "canceled", 100), sub("new", "unpaid", 200)])?.id).toBe("new");
    expect(pick([])).toBeNull();
  });
});

describe("syncWorkspaceBilling", () => {
  it("keeps a customer on their new plan when the old subscription's deletion arrives late", async () => {
    // The order a resubscribe can deliver in: the new subscription is active, then `deleted` for the old one lands.
    mocks.list.mockReturnValue(listing([sub("sub_new", "active", 2000, "price_office_m"), sub("sub_old", "canceled", 1000)]));
    mocks.findFirst.mockResolvedValueOnce({ id: "ws_1" });
    const result = await syncWorkspaceBilling("cus_1");
    expect(mocks.list).toHaveBeenCalledWith({ customer: "cus_1", status: "all", limit: 100 });
    expect(result).toMatchObject({ workspaceId: "ws_1", plan: "OFFICE", subscription: { id: "sub_new" } });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "ws_1" },
      data: { plan: "OFFICE", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_new", planRenewsAt: new Date((2000 + 30 * 86400) * 1000) },
    });
  });

  it("writes Free and clears the subscription once every subscription has ended, keeping the customer", async () => {
    mocks.list.mockReturnValue(listing([sub("sub_old", "canceled", 1000)]));
    mocks.findFirst.mockResolvedValueOnce({ id: "ws_1" });
    await syncWorkspaceBilling("cus_1");
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "ws_1" }, data: { plan: "FREE", stripeCustomerId: "cus_1", stripeSubscriptionId: null, planRenewsAt: null } });
  });

  it("finds a first checkout's workspace by the hint when the customer is not linked yet, and writes nothing without one", async () => {
    mocks.list.mockReturnValue(listing([sub("sub_new", "active", 2000)]));
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "ws_hint" });
    expect(await syncWorkspaceBilling("cus_1", "ws_hint")).toMatchObject({ workspaceId: "ws_hint", plan: "AGENT" });
    expect(mocks.findFirst).toHaveBeenLastCalledWith({ where: { id: "ws_hint" }, select: { id: true } });

    mocks.update.mockClear();
    mocks.list.mockReturnValue(listing([]));
    mocks.findFirst.mockResolvedValue(null);
    expect(await syncWorkspaceBilling("cus_unknown")).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("confirmCheckoutReturn", () => {
  it("ignores a session that belongs to another customer, whatever the URL says", async () => {
    mocks.findUnique.mockResolvedValue({ stripeCustomerId: "cus_1" });
    mocks.retrieveSession.mockResolvedValue({ id: "cs_test_x", customer: "cus_other", mode: "subscription" });
    expect(await confirmCheckoutReturn("ws_1", "cs_test_x", "welcome")).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.retrieveSession.mockResolvedValue({ id: "cs_test_x", customer: "cus_other", mode: "payment", payment_status: "paid", metadata: { purpose: "ai-top-up" }, client_reference_id: "ws_1" });
    expect(await confirmCheckoutReturn("ws_1", "cs_test_x", "credits")).toBe(false);
    expect(mocks.applyAiTopUp).not.toHaveBeenCalled();
  });

  it("does not ask Stripe about a malformed session id", async () => {
    expect(await confirmCheckoutReturn("ws_1", "cs_x/../../v1/customers", "welcome")).toBe(false);
    expect(await confirmCheckoutReturn("ws_1", undefined, "welcome")).toBe(false);
    expect(mocks.retrieveSession).not.toHaveBeenCalled();
  });

  it("confirms the plan by syncing the workspace's own customer", async () => {
    mocks.findUnique.mockResolvedValue({ stripeCustomerId: "cus_1" });
    mocks.retrieveSession.mockResolvedValue({ id: "cs_test_x", customer: "cus_1", mode: "subscription" });
    mocks.list.mockReturnValue(listing([sub("sub_new", "active", 2000)]));
    mocks.findFirst.mockResolvedValueOnce({ id: "ws_1" });
    expect(await confirmCheckoutReturn("ws_1", "cs_test_x", "welcome")).toBe(true);
  });

  it("grants paid credits through the webhook's idempotent grant", async () => {
    mocks.findUnique.mockResolvedValue({ stripeCustomerId: "cus_1" });
    const session = { id: "cs_test_x", customer: "cus_1", mode: "payment", payment_status: "paid", metadata: { purpose: "ai-top-up" }, client_reference_id: "ws_1" };
    mocks.retrieveSession.mockResolvedValue(session);
    expect(await confirmCheckoutReturn("ws_1", "cs_test_x", "credits")).toBe(true);
    expect(mocks.applyAiTopUp).toHaveBeenCalledWith(session);
  });

  it("falls back to today's message, never an error, when Stripe fails or is slow", async () => {
    mocks.findUnique.mockResolvedValue({ stripeCustomerId: "cus_1" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.retrieveSession.mockRejectedValue(new Error("Stripe is down"));
    expect(await confirmCheckoutReturn("ws_1", "cs_test_x", "welcome")).toBe(false);
    vi.useFakeTimers();
    try {
      mocks.retrieveSession.mockReturnValue(new Promise(() => {}));
      const pending = confirmCheckoutReturn("ws_1", "cs_test_y", "welcome");
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
