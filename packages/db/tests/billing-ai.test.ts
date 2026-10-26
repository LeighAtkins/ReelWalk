import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { aiCreditSummary, prisma, reserveAiGeneration } from "../src";
const mocks = vi.hoisted(() => ({ listLineItems: vi.fn() }));
vi.mock("../../../apps/web/lib/stripe", () => ({
  customerId: (value: string | { id: string } | null) => typeof value === "string" ? value : value?.id ?? null,
  planForPrice: (ref: string | { id?: string | null }) => { const id = typeof ref === "string" ? ref : ref.id; return id === "price-agent" ? "AGENT" : id === "price-studio" ? "OFFICE" : null; },
  stripe: () => ({ checkout: { sessions: { listLineItems: mocks.listLineItems } } }),
}));
import { applyAiInvoice, applyAiTopUp } from "../../../apps/web/lib/billing-ai";

describe.skipIf(!process.env.DATABASE_URL)("Stripe AI funding (Postgres)", () => {
  const ids: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const end = now + 28 * 86400;
  async function studio() {
    const workspace = await prisma.workspace.create({ data: {
      name: "Billing AI test", slug: `billing-ai-${randomUUID()}`, stripeCustomerId: `cus_${randomUUID()}`,
      stripeSubscriptionId: `sub_${randomUUID()}`, users: { create: { email: `${randomUUID()}@example.test`, name: "Tester" } },
    }, include: { users: true } }); ids.push(workspace.id); return workspace;
  }
  function invoice(customer: string, price = "price-agent", created = now) {
    return { status: "paid", customer, created, lines: { data: [{ amount: 3900, period: { start: now, end }, pricing: { price_details: { price } } }] } } as unknown as Parameters<typeof applyAiInvoice>[0];
  }
  function subscription(workspace: { stripeCustomerId: string | null; stripeSubscriptionId: string | null }) {
    return { id: workspace.stripeSubscriptionId, customer: workspace.stripeCustomerId, status: "active", items: { data: [] } } as unknown as Parameters<typeof applyAiInvoice>[1];
  }
  let charged = 0;
  afterAll(async () => {
    await prisma.aiGeneration.deleteMany({ where: { workspaceId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
    if (charged) await prisma.aiSpendBudget.update({ where: { id: "vertex-video" }, data: { reservedCents: { decrement: charged } } });
    delete process.env.STRIPE_PRICE_AI_TOP_UP;
    delete process.env.STRIPE_PRICE_AI_TOP_UP_USD;
    await prisma.$disconnect();
  });
  it("paid invoice replay cannot restore spent monthly credits", async () => {
    const w = await studio(); const paid = invoice(w.stripeCustomerId!);
    await applyAiInvoice(paid, subscription(w));
    expect((await aiCreditSummary(prisma, w.id)).monthly).toBe(20);
    await reserveAiGeneration(prisma, { workspaceId: w.id, userId: w.users[0]!.id, requestId: randomUUID(), prompt: "A sunny room", model: "test", durationSeconds: 4, costCents: 40, budgetCents: 1_000_000 }); charged += 40;
    await applyAiInvoice(paid, subscription(w));
    expect((await aiCreditSummary(prisma, w.id)).monthly).toBe(19);
  });
  it("a paid prorated upgrade adds only the difference and ignores older invoices", async () => {
    const w = await studio();
    await applyAiInvoice(invoice(w.stripeCustomerId!), subscription(w));
    const upgrade = invoice(w.stripeCustomerId!, "price-studio", now + 1);
    upgrade.lines.data.unshift({ amount: -1000, pricing: { price_details: { price: "price-agent" } } } as typeof upgrade.lines.data[number]);
    await applyAiInvoice(upgrade, subscription(w));
    expect((await aiCreditSummary(prisma, w.id)).monthly).toBe(60);
    await applyAiInvoice(invoice(w.stripeCustomerId!), subscription(w));
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: w.id } })).aiPaidPlan).toBe("OFFICE");
  });
  it("an unpaid invoice does not fund generation", async () => {
    const w = await studio(); const unpaid = invoice(w.stripeCustomerId!); unpaid.status = "open";
    await applyAiInvoice(unpaid, subscription(w));
    expect((await aiCreditSummary(prisma, w.id)).monthly).toBe(0);
  });
  it("a paid top-up is granted once across concurrent delivery and rejects the wrong customer", async () => {
    const w = await studio(); process.env.STRIPE_PRICE_AI_TOP_UP = "price-top-up";
    mocks.listLineItems.mockResolvedValue({ data: [{ price: { id: "price-top-up" }, quantity: 1 }] });
    const session = { id: `cs_${randomUUID()}`, mode: "payment", payment_status: "paid", metadata: { purpose: "ai-top-up" }, currency: "aud", amount_subtotal: 1900, amount_total: 1900, customer: w.stripeCustomerId, client_reference_id: w.id } as unknown as Parameters<typeof applyAiTopUp>[0];
    await Promise.all([applyAiTopUp(session), applyAiTopUp(session)]);
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(10);
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, customer: "cus_wrong" })).rejects.toThrow("does not match");
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(10);
  });
  it("funds an A$19 top-up (GST inside the price, or added on top), but rejects discounts, USD and unexplained totals", async () => {
    const w = await studio(); process.env.STRIPE_PRICE_AI_TOP_UP = "price-top-up";
    mocks.listLineItems.mockResolvedValue({ data: [{ price: { id: "price-top-up" }, quantity: 1 }] });
    const session = { id: `cs_${randomUUID()}`, mode: "payment", payment_status: "paid", metadata: { purpose: "ai-top-up" }, currency: "aud", amount_subtotal: 1900, amount_total: 2090, total_details: { amount_tax: 190, amount_discount: 0, amount_shipping: 0 }, customer: w.stripeCustomerId, client_reference_id: w.id } as unknown as Parameters<typeof applyAiTopUp>[0];
    await applyAiTopUp(session);
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(10);
    // A GST-inclusive price: the total is the price, with the tax shown inside it.
    await applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, amount_total: 1900, total_details: { amount_tax: 173, amount_discount: 0, amount_shipping: 0 } } as typeof session);
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(20);
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, amount_total: 1500 })).rejects.toThrow("Unexpected");
    // A US$ session must have bought the US$ price at US$12: the A$ line and amount are refused.
    process.env.STRIPE_PRICE_AI_TOP_UP_USD = "price-top-up-usd";
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, currency: "usd" })).rejects.toThrow("Unexpected");
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, currency: "eur" })).rejects.toThrow("Unexpected");
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, total_details: { ...session.total_details!, amount_discount: 150 } })).rejects.toThrow("Unexpected");
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, amount_subtotal: 1400 })).rejects.toThrow("Unexpected");
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(20);
  });
  it("funds a US$12 top-up with the tax added on top (ADR 0085), and only through the US$ price", async () => {
    const w = await studio(); process.env.STRIPE_PRICE_AI_TOP_UP = "price-top-up"; process.env.STRIPE_PRICE_AI_TOP_UP_USD = "price-top-up-usd";
    mocks.listLineItems.mockResolvedValue({ data: [{ price: { id: "price-top-up-usd" }, quantity: 1 }] });
    const session = { id: `cs_${randomUUID()}`, mode: "payment", payment_status: "paid", metadata: { purpose: "ai-top-up" }, currency: "usd", amount_subtotal: 1200, amount_total: 1299, total_details: { amount_tax: 99, amount_discount: 0, amount_shipping: 0 }, customer: w.stripeCustomerId, client_reference_id: w.id } as unknown as Parameters<typeof applyAiTopUp>[0];
    await applyAiTopUp(session);
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(10);
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, amount_subtotal: 1900, amount_total: 1900 })).rejects.toThrow("Unexpected");
    mocks.listLineItems.mockResolvedValue({ data: [{ price: { id: "price-top-up" }, quantity: 1 }] });
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}` })).rejects.toThrow("Unexpected");
    delete process.env.STRIPE_PRICE_AI_TOP_UP_USD;
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}` })).rejects.toThrow("not configured");
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(10);
  });
});
