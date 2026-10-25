import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invoiceLinePlan } from "./billing-ai";
import { planForPrice, planForSubscription } from "./stripe";

// The AUD prices (ADR 0081) replace the USD ones in env. A subscription bought in USD keeps pointing at
// its old price, so plans must still resolve from the price's lookup key or its product.
const ENV = ["STRIPE_PRICE_AGENT_MONTHLY", "STRIPE_PRICE_AGENT_YEARLY", "STRIPE_PRICE_OFFICE_MONTHLY", "STRIPE_PRICE_OFFICE_YEARLY", "STRIPE_PRODUCT_AGENT", "STRIPE_PRODUCT_OFFICE"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    STRIPE_PRICE_AGENT_MONTHLY: "price_agent_aud_m", STRIPE_PRICE_AGENT_YEARLY: "price_agent_aud_y",
    STRIPE_PRICE_OFFICE_MONTHLY: "price_office_aud_m", STRIPE_PRICE_OFFICE_YEARLY: "price_office_aud_y",
    STRIPE_PRODUCT_AGENT: "prod_agent", STRIPE_PRODUCT_OFFICE: "prod_office",
  });
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("planForPrice", () => {
  it("matches the env price ids, as a bare id or inside a price", () => {
    expect(planForPrice("price_agent_aud_m")).toBe("AGENT");
    expect(planForPrice({ id: "price_office_aud_y" })).toBe("OFFICE");
  });

  it("resolves an old USD price by its product", () => {
    expect(planForPrice({ id: "price_agent_usd_m", lookup_key: null, product: "prod_agent" })).toBe("AGENT");
    expect(planForPrice({ id: "price_office_usd_y", product: { id: "prod_office" } })).toBe("OFFICE");
  });

  it("resolves a swapped price by its lookup key when the env ids moved on", () => {
    expect(planForPrice({ id: "price_new", lookup_key: "agent_yearly_aud" })).toBe("AGENT");
    expect(planForPrice({ id: "price_new", lookup_key: "office_monthly_aud", product: "prod_other" })).toBe("OFFICE");
  });

  it("leaves a price it does not know unresolved", () => {
    expect(planForPrice({ id: "price_x", lookup_key: "something_else", product: "prod_ai_top_up" })).toBeNull();
    expect(planForPrice({ id: "price_x", lookup_key: "toString" })).toBeNull();
    expect(planForPrice("price_x")).toBeNull();
    expect(planForPrice(null)).toBeNull();
    expect(planForPrice(undefined)).toBeNull();
  });

  it("does not match a product when the env var is unset or 'unset'", () => {
    delete process.env.STRIPE_PRODUCT_AGENT;
    process.env.STRIPE_PRODUCT_OFFICE = "unset";
    expect(planForPrice({ id: "price_old", product: "prod_agent" })).toBeNull();
    expect(planForPrice({ id: "price_old", product: "unset" })).toBeNull();
  });
});

describe("planForSubscription", () => {
  const sub = (status: string, price: Record<string, unknown>) => ({ status, items: { data: [{ price }] } }) as unknown as Parameters<typeof planForSubscription>[0];

  it("keeps an old USD subscription on its plan through its price object", () => {
    expect(planForSubscription(sub("active", { id: "price_agent_usd_m", lookup_key: null, product: "prod_agent" }))).toBe("AGENT");
    expect(planForSubscription(sub("past_due", { id: "price_office_usd_m", product: "prod_office" }))).toBe("OFFICE");
  });

  it("is Free when the subscription is not in good standing or the price is unknown", () => {
    expect(planForSubscription(sub("canceled", { id: "price_agent_aud_m" }))).toBe("FREE");
    expect(planForSubscription(sub("active", { id: "price_mystery", product: "prod_mystery" }))).toBe("FREE");
  });
});

describe("invoiceLinePlan", () => {
  const line = (price: unknown, product?: string) => ({ amount: 2900, pricing: { price_details: { price, product } } }) as unknown as Parameters<typeof invoiceLinePlan>[0];
  const subscription = (price: Record<string, unknown>) => ({ items: { data: [{ price }] } }) as unknown as Parameters<typeof invoiceLinePlan>[1];

  it("reads an old USD invoice line by the line's product", () => {
    expect(invoiceLinePlan(line("price_agent_usd_m", "prod_agent"), subscription({ id: "price_agent_usd_m" }))).toBe("AGENT");
  });

  it("finds the lookup key on the subscription item when the line only names the price id", () => {
    expect(invoiceLinePlan(line("price_new", "prod_other"), subscription({ id: "price_new", lookup_key: "office_yearly_aud" }))).toBe("OFFICE");
  });

  it("accepts an expanded price on the line", () => {
    expect(invoiceLinePlan(line({ id: "price_new", lookup_key: "agent_monthly_aud", product: "prod_other" }), subscription({ id: "other" }))).toBe("AGENT");
  });

  it("is null for a line that is neither plan", () => {
    expect(invoiceLinePlan(line("price_ai", "prod_ai_top_up"), subscription({ id: "price_agent_aud_m" }))).toBeNull();
  });
});
