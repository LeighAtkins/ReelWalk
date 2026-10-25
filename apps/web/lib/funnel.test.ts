import { beforeEach, describe, expect, it, vi } from "vitest";

// The database is faked: what matters here is what gets written and how rows are counted.
const db = vi.hoisted(() => {
  class KnownError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    KnownError,
    created: [] as Record<string, unknown>[],
    users: new Map<string, { attribution: unknown }>(),
    events: [] as { name: string; data: unknown }[],
    failWith: null as Error | null,
  };
});

vi.mock("@reelwalk/db", () => ({
  Prisma: { PrismaClientKnownRequestError: db.KnownError },
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => db.users.get(where.id) ?? null,
      findFirst: async () => ({ id: "u1" }),
    },
    funnelEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (db.failWith) throw db.failWith;
        db.created.push(data);
      },
      findMany: async () => db.events,
    },
  },
}));

import { funnelSummary, recordFunnelEvent } from "./funnel";

beforeEach(() => {
  db.created.length = 0;
  db.users.clear();
  db.events.length = 0;
  db.failWith = null;
});

describe("recordFunnelEvent", () => {
  it("stores the event with the person's sign-up attribution and the event's own data", async () => {
    db.users.set("u1", { attribution: { utm_source: "meta", fbclid: "abc", junk: "x" } });
    await recordFunnelEvent({ name: "checkout_started", userId: "u1", workspaceId: "w1", data: { plan: "AGENT", interval: "month" } });
    expect(db.created).toEqual([
      { name: "checkout_started", userId: "u1", workspaceId: "w1", eventKey: null, data: { utm_source: "meta", fbclid: "abc", plan: "AGENT", interval: "month" } },
    ]);
  });

  it("finds the studio's first member when only the workspace is known (a Stripe webhook)", async () => {
    await recordFunnelEvent({ name: "subscribed", workspaceId: "w1", key: "subscribed:sub_1", data: { plan: "AGENT" } });
    expect(db.created[0]).toMatchObject({ userId: "u1", workspaceId: "w1", eventKey: "subscribed:sub_1" });
  });

  it("drops a repeated key without complaint", async () => {
    db.failWith = new db.KnownError("P2002");
    await expect(recordFunnelEvent({ name: "first_export", userId: "u1", key: "first_export:w1" })).resolves.toBeUndefined();
  });

  it("never throws into the request it is counting", async () => {
    db.failWith = new Error("connection closed");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recordFunnelEvent({ name: "signup", userId: "u1" })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("funnelSummary", () => {
  it("counts per source and campaign, falling back to the click id's platform, busiest first", async () => {
    db.events.push(
      { name: "signup", data: { utm_source: "meta", utm_campaign: "agents" } },
      { name: "signup", data: { utm_source: "meta", utm_campaign: "agents" } },
      { name: "subscribed", data: { utm_source: "meta", utm_campaign: "agents", plan: "AGENT" } },
      { name: "signup", data: { fbclid: "x" } },
      { name: "signup", data: null },
      { name: "something_else", data: {} },
    );
    const { total, rows } = await funnelSummary(new Date(0));
    expect(total).toEqual({ signup: 4, first_export: 0, checkout_started: 0, subscribed: 1 });
    expect(rows.map((r) => [r.source, r.campaign, r.counts.signup, r.counts.subscribed])).toEqual([
      ["meta", "agents", 2, 1],
      ["facebook (fbclid)", "(none)", 1, 0],
      ["(none)", "(none)", 1, 0],
    ]);
  });
});
