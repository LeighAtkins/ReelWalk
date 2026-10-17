import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { aiCreditSummary, prisma, reserveAiGeneration } from "../src";
const mocks = vi.hoisted(() => ({ listLineItems: vi.fn() }));
vi.mock("../../../apps/web/lib/stripe", () => ({
  customerId: (value: string | { id: string } | null) => typeof value === "string" ? value : value?.id ?? null,
  planForPrice: (id: string) => id === "price-agent" ? "AGENT" : id === "price-studio" ? "OFFICE" : null,
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
    return { status: "paid", customer, created, lines: { data: [{ amount: 2900, period: { start: now, end }, pricing: { price_details: { price } } }] } } as unknown as Parameters<typeof applyAiInvoice>[0];
  }
  function subscription(workspace: { stripeCustomerId: string | null; stripeSubscriptionId: string | null }) {
    return { id: workspace.stripeSubscriptionId, customer: workspace.stripeCustomerId, status: "active" } as unknown as Parameters<typeof applyAiInvoice>[1];
  }
  let charged = 0;
  afterAll(async () => {
    await prisma.aiGeneration.deleteMany({ where: { workspaceId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
    if (charged) await prisma.aiSpendBudget.update({ where: { id: "vertex-video" }, data: { reservedCents: { decrement: charged } } });
    delete process.env.STRIPE_PRICE_AI_TOP_UP;
    await prisma.$disconnect();
  });
  it("paid invoice replay cannot restore spent monthly credits", async () => {
    const w = await studio(); const paid = invoice(w.stripeCustomerId!);
    await applyAiInvoice(paid, subscription(w));
    expect((await aiCreditSummary(prisma, w.id)).monthly).toBe(10);
    await reserveAiGeneration(prisma, { workspaceId: w.id, userId: w.users[0]!.id, requestId: randomUUID(), prompt: "A sunny room", model: "test", costCents: 80, budgetCents: 1_000_000 }); charged += 80;
    await applyAiInvoice(paid, subscription(w));
    expect((await aiCreditSummary(prisma, w.id)).monthly).toBe(9);
  });
  it("a paid prorated upgrade adds only the difference and ignores older invoices", async () => {
    const w = await studio();
    await applyAiInvoice(invoice(w.stripeCustomerId!), subscription(w));
    const upgrade = invoice(w.stripeCustomerId!, "price-studio", now + 1);
    upgrade.lines.data.unshift({ amount: -1000, pricing: { price_details: { price: "price-agent" } } } as typeof upgrade.lines.data[number]);
    await applyAiInvoice(upgrade, subscription(w));
    expect((await aiCreditSummary(prisma, w.id)).monthly).toBe(30);
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
    const session = { id: `cs_${randomUUID()}`, mode: "payment", payment_status: "paid", metadata: { purpose: "ai-top-up" }, currency: "usd", amount_total: 1500, customer: w.stripeCustomerId, client_reference_id: w.id } as unknown as Parameters<typeof applyAiTopUp>[0];
    await Promise.all([applyAiTopUp(session), applyAiTopUp(session)]);
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(5);
    await expect(applyAiTopUp({ ...session, id: `cs_${randomUUID()}`, customer: "cus_wrong" })).rejects.toThrow("does not match");
    expect((await aiCreditSummary(prisma, w.id)).topUp).toBe(5);
  });
});
