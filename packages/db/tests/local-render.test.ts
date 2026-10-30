import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  handOffLocalRender,
  LOCAL_RENDER_JOBS_TOPIC,
  localRenderFallbackMs,
  localRenderPolicyFromEnv,
  moveStalledLocalRenders,
  prisma,
  RENDER_JOBS_TOPIC,
  renderJobsTopic,
  renderRouteFor,
} from "../src/index";

describe("localRenderPolicyFromEnv", () => {
  it("is off without a queue, or with nobody on the list", () => {
    expect(localRenderPolicyFromEnv({})).toBeNull();
    expect(localRenderPolicyFromEnv({ LOCAL_RENDER_WORKSPACES: "ws-1" })).toBeNull();
    expect(localRenderPolicyFromEnv({ LOCAL_RENDER_QUEUE_URL: "https://sqs/local", LOCAL_RENDER_WORKSPACES: " " })).toBeNull();
  });

  it("reads a comma or space separated list of workspaces", () => {
    const policy = localRenderPolicyFromEnv({ LOCAL_RENDER_QUEUE_URL: "https://sqs/local", LOCAL_RENDER_WORKSPACES: "ws-1, ws-2  ws-3" });
    expect(policy).toEqual({ queueUrl: "https://sqs/local", workspaceIds: new Set(["ws-1", "ws-2", "ws-3"]) });
  });

  it("waits ten minutes before the fallback unless LOCAL_RENDER_FALLBACK_SECONDS says otherwise, ignoring nonsense", () => {
    expect(localRenderFallbackMs({})).toBe(600_000);
    expect(localRenderFallbackMs({ LOCAL_RENDER_FALLBACK_SECONDS: "90" })).toBe(90_000);
    expect(localRenderFallbackMs({ LOCAL_RENDER_FALLBACK_SECONDS: "soon" })).toBe(600_000);
    expect(localRenderFallbackMs({ LOCAL_RENDER_FALLBACK_SECONDS: "0" })).toBe(600_000);
  });

  it("maps a route to its outbox topic", () => {
    expect(renderJobsTopic("local")).toBe(LOCAL_RENDER_JOBS_TOPIC);
    expect(renderJobsTopic("cloud")).toBe(RENDER_JOBS_TOPIC);
  });
});

describe("renderRouteFor", () => {
  const policy = localRenderPolicyFromEnv({ LOCAL_RENDER_QUEUE_URL: "q", LOCAL_RENDER_WORKSPACES: "ours" });

  it("sends only listed workspaces to the PC, with no lookup that could fail, stall or go stale", () => {
    expect(renderRouteFor(policy, "ours")).toBe("local");
    expect(renderRouteFor(policy, "customer")).toBe("cloud");
    expect(renderRouteFor(null, "ours")).toBe("cloud");
  });
});

// Routing and the fallback are SQL (who owns what, conditional moves), so they run against a real,
// migrated Postgres; skipped without DATABASE_URL, as in outbox.test.ts.
describe.skipIf(!process.env.DATABASE_URL)("local render routing (Postgres)", () => {
  const tag = randomUUID().slice(0, 8);
  let home: string, owned: string, customer: string;
  const serialize = (message: { jobId: string; generation: number }) => JSON.stringify(message);
  const fallbackMs = 10 * 60_000;
  const minutesAgo = (minutes: number, from = new Date()) => new Date(from.getTime() - minutes * 60_000);

  beforeAll(async () => {
    const workspace = (name: string) => prisma.workspace.create({ data: { slug: `test-local-${name}-${tag}`, name } }).then((w) => w.id);
    [home, owned, customer] = await Promise.all(["home", "owned", "customer"].map(workspace)) as [string, string, string];
  });

  afterAll(async () => {
    const ids = [home, owned, customer].filter(Boolean);
    const jobs = await prisma.renderJob.findMany({ where: { workspaceId: { in: ids } }, select: { id: true } });
    if (jobs.length) await prisma.outboxMessage.deleteMany({ where: { OR: jobs.map((j) => ({ body: { contains: j.id } })) } });
    await prisma.renderJob.deleteMany({ where: { workspaceId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  /** A job sent to `route`, whose row says it was queued (or last heartbeat) `minutes` ago. */
  async function job(workspaceId: string, status: "QUEUED" | "RUNNING" | "SUCCEEDED", minutes: number, heartbeatMinutes?: number, route = "local") {
    const created = await prisma.renderJob.create({ data: { workspaceId, kind: "REEL", status, caption: tag, generation: 2, route, interruptions: 1 } });
    await age(created.id, minutes, heartbeatMinutes);
    return created.id;
  }
  // updatedAt is @updatedAt, so it is backdated in SQL.
  const age = (id: string, minutes: number, heartbeatMinutes?: number) =>
    prisma.$executeRaw`UPDATE "RenderJob" SET "updatedAt" = ${minutesAgo(minutes)}, "heartbeatAt" = ${heartbeatMinutes === undefined ? null : minutesAgo(heartbeatMinutes)} WHERE "id" = ${id}`;

  it("moves only jobs sent to the local queue and left unclaimed, or with a dead heartbeat, to the cloud queue under a new generation", async () => {
    const waited = await job(home, "QUEUED", 11);
    const fresh = await job(home, "QUEUED", 2);
    const dead = await job(owned, "RUNNING", 30, 12);
    const alive = await job(owned, "RUNNING", 30, 0.2);
    const done = await job(home, "SUCCEEDED", 60);
    // Our own workspace, but this generation was sent to the cloud (say the policy was off then): not the fallback's.
    const cloud = await job(home, "QUEUED", 30, undefined, "cloud");

    const moved = await moveStalledLocalRenders(prisma, { fallbackMs, serialize });
    expect(new Set(moved)).toEqual(new Set([waited, dead]));

    const rows = await prisma.renderJob.findMany({ where: { id: { in: [waited, fresh, dead, alive, done, cloud] } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [waited, dead]) expect(byId.get(id)).toMatchObject({ route: "cloud", status: "QUEUED", generation: 3, heartbeatAt: null, progress: 0, interruptions: 0 });
    expect(byId.get(fresh)).toMatchObject({ route: "local", status: "QUEUED", generation: 2 });
    expect(byId.get(alive)).toMatchObject({ route: "local", status: "RUNNING", generation: 2 });
    expect(byId.get(done)).toMatchObject({ status: "SUCCEEDED", generation: 2 });
    expect(byId.get(cloud)).toMatchObject({ route: "cloud", status: "QUEUED", generation: 2 });

    // The new messages are on the cloud topic; the local queue's old ones now name a stale generation.
    const outbox = await prisma.outboxMessage.findMany({ where: { body: { contains: waited } } });
    expect(outbox.map((row) => [row.topic, JSON.parse(row.body)])).toEqual([[RENDER_JOBS_TOPIC, { jobId: waited, generation: 3 }]]);
  });

  it("never moves a job twice, however long it then waits on the cloud", async () => {
    const id = await job(home, "QUEUED", 11);
    expect(await moveStalledLocalRenders(prisma, { fallbackMs, serialize })).toContain(id);
    // Another fallback window passes with no cloud worker yet (reproduced before the route was stored).
    await age(id, 25);
    expect(await moveStalledLocalRenders(prisma, { fallbackMs, serialize })).not.toContain(id);
    expect(await prisma.renderJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ route: "cloud", generation: 3 });
    expect(await prisma.outboxMessage.count({ where: { body: { contains: id } } })).toBe(1);
  });

  it("rescues by the route the job was sent on, not by who owns the workspace now", async () => {
    // The customer's studio is on no list, but this job was sent to the PC (the list changed while the PC was off).
    const orphan = await job(customer, "QUEUED", 15);
    expect(await moveStalledLocalRenders(prisma, { fallbackMs, serialize })).toContain(orphan);
  });

  it("leaves a job a local worker claims at the same moment with that worker", async () => {
    const racing = await job(home, "QUEUED", 15);
    const original = prisma.$transaction.bind(prisma);
    // The local worker's claim lands between the sweep's read and its conditional write.
    const spy = async (fn: Parameters<typeof prisma.$transaction>[0]) => {
      await prisma.renderJob.update({ where: { id: racing }, data: { status: "RUNNING", heartbeatAt: new Date(), attempt: { increment: 1 } } });
      return original(fn as never);
    };
    const db = { renderJob: prisma.renderJob, $transaction: spy } as unknown as typeof prisma;
    const moved = await moveStalledLocalRenders(db, { fallbackMs, serialize });
    expect(moved).not.toContain(racing);
    expect(await prisma.renderJob.findUniqueOrThrow({ where: { id: racing } })).toMatchObject({ route: "local", status: "RUNNING", generation: 2 });
    expect(await prisma.outboxMessage.count({ where: { body: { contains: racing } } })).toBe(0);
  });

  it("lets the PC worker hand an unclaimed job to the cloud without spending an attempt, once", async () => {
    const id = await job(home, "QUEUED", 1);
    const before = await prisma.renderJob.findUniqueOrThrow({ where: { id } });
    expect(await handOffLocalRender(prisma, { jobId: id, generation: 2 }, serialize)).toBe(true);
    expect(await prisma.renderJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ route: "cloud", status: "QUEUED", generation: 3, attempt: before.attempt });
    // Its local message is now stale: handing it off again does nothing.
    expect(await handOffLocalRender(prisma, { jobId: id, generation: 2 }, serialize)).toBe(false);
    const claimed = await job(home, "RUNNING", 1, 0.1);
    expect(await handOffLocalRender(prisma, { jobId: claimed, generation: 2 }, serialize)).toBe(false);
  });
});
