import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { addToOutbox, outboxRetryDelaySeconds, prisma, relayOutbox } from "../src/index";

describe("outboxRetryDelaySeconds", () => {
  it("doubles from one second up to the cap", () => {
    expect([1, 2, 3, 4].map((attempts) => outboxRetryDelaySeconds(attempts))).toEqual([1, 2, 4, 8]);
    expect(outboxRetryDelaySeconds(20)).toBe(60);
  });
});

// The outbox is a locking rule in SQL, so it is tested against a real,
// migrated Postgres. Without DATABASE_URL (a plain `pnpm test` on a laptop)
// these are skipped; CI provides a database.
describe.skipIf(!process.env.DATABASE_URL)("outbox (Postgres)", () => {
  // Each test relays its own topic, so it never touches real pending messages.
  const prefix = `test-${randomUUID()}`;
  const newTopic = () => `${prefix}-${randomUUID()}`;
  const pending = (topic: string) => prisma.outboxMessage.findMany({ where: { topic }, orderBy: { createdAt: "asc" } });
  const add = (topic: string, bodies: string[]) =>
    prisma.$transaction(async (tx) => {
      for (const body of bodies) await addToOutbox(tx, topic, body);
    });

  afterAll(async () => {
    await prisma.outboxMessage.deleteMany({ where: { topic: { startsWith: prefix } } });
    await prisma.$disconnect();
  });

  it("writes no message when the transaction rolls back", async () => {
    const topic = newTopic();
    await expect(
      prisma.$transaction(async (tx) => {
        await addToOutbox(tx, topic, "never sent");
        throw new Error("job insert failed");
      }),
    ).rejects.toThrow("job insert failed");

    expect(await pending(topic)).toEqual([]);
  });

  it("sends committed messages oldest first and deletes them", async () => {
    const topic = newTopic();
    await add(topic, ["a", "b", "c"]);
    const sent: string[] = [];

    const result = await relayOutbox(prisma, { topic, send: async (body) => void sent.push(body) });

    expect(result).toEqual({ sent: 3, failed: 0 });
    expect(sent).toEqual(["a", "b", "c"]);
    expect(await pending(topic)).toEqual([]);
  });

  it("keeps a message whose send failed and backs off before the next try", async () => {
    const topic = newTopic();
    await add(topic, ["a"]);
    const down = async () => {
      throw new Error("queue unreachable");
    };

    expect(await relayOutbox(prisma, { topic, send: down })).toEqual({ sent: 0, failed: 1 });

    const [row] = await pending(topic);
    expect(row).toMatchObject({ body: "a", attempts: 1, lastError: "queue unreachable" });
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());

    // Not due yet: nothing is tried, and nothing is lost.
    const sent: string[] = [];
    expect(await relayOutbox(prisma, { topic, send: async (body) => void sent.push(body) })).toEqual({ sent: 0, failed: 0 });

    await prisma.outboxMessage.update({ where: { id: row.id }, data: { availableAt: new Date(Date.now() - 1000) } });
    expect(await relayOutbox(prisma, { topic, send: async (body) => void sent.push(body) })).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual(["a"]);
    expect(await pending(topic)).toEqual([]);
  });

  it("does not send a message twice when relays run at the same time", async () => {
    const topic = newTopic();
    const bodies = Array.from({ length: 12 }, (_, index) => `m${index}`);
    await add(topic, bodies);
    const sent: string[] = [];
    // Slow enough that the relays overlap while each holds a row lock.
    const send = async (body: string) => {
      await sleep(20);
      sent.push(body);
    };

    const results = await Promise.all([1, 2, 3].map(() => relayOutbox(prisma, { topic, send })));

    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(12);
    expect([...sent].sort()).toEqual([...bodies].sort());
    expect(await pending(topic)).toEqual([]);
  });

  it("stops at the limit", async () => {
    const topic = newTopic();
    await add(topic, ["a", "b", "c"]);

    expect(await relayOutbox(prisma, { topic, limit: 2, send: async () => {} })).toEqual({ sent: 2, failed: 0 });
    expect(await pending(topic)).toHaveLength(1);
  });
});
