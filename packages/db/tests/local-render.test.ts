import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRenderRouter,
  handOffLocalRender,
  LOCAL_RENDER_JOBS_TOPIC,
  localRenderFallbackMs,
  localRenderPolicyFromEnv,
  localRenderWorkspaceIds,
  moveStalledLocalRenders,
  prisma,
  RENDER_JOBS_TOPIC,
  renderJobsTopic,
  type LocalRenderPolicy,
} from "../src/index";

describe("localRenderPolicyFromEnv", () => {
  it("is off without a queue, or with nobody on the list", () => {
    expect(localRenderPolicyFromEnv({})).toBeNull();
    expect(localRenderPolicyFromEnv({ LOCAL_RENDER_WORKSPACES: "ws-1" })).toBeNull();
    expect(localRenderPolicyFromEnv({ LOCAL_RENDER_QUEUE_URL: "https://sqs/local", LOCAL_RENDER_WORKSPACES: " ", LOCAL_RENDER_EMAILS: "" })).toBeNull();
  });

  it("reads comma or space separated lists and lower-cases emails", () => {
    const policy = localRenderPolicyFromEnv({
      LOCAL_RENDER_QUEUE_URL: "https://sqs/local",
      LOCAL_RENDER_WORKSPACES: "ws-1, ws-2  ws-3",
      LOCAL_RENDER_EMAILS: "Leigh@Example.com",
    });
    expect(policy).toEqual({ queueUrl: "https://sqs/local", workspaceIds: new Set(["ws-1", "ws-2", "ws-3"]), emails: new Set(["leigh@example.com"]) });
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

describe("createRenderRouter", () => {
  const policy: LocalRenderPolicy = { queueUrl: "q", workspaceIds: new Set(["listed"]), emails: new Set(["owner@example.com"]) };
  /** A database whose owner lookup answers `rows`, fails, or hangs. */
  function db(behaviour: "ok" | "fail" | "hang", rows = [{ workspaceId: "owned" }]) {
    const answer = () => (behaviour === "ok" ? Promise.resolve(rows) : behaviour === "fail" ? Promise.reject(new Error("connection reset")) : new Promise<never>(() => undefined));
    return { user: { findMany: vi.fn(answer) }, workspaceMember: { findMany: vi.fn(answer) } };
  }
  const quiet = { log: () => undefined };

  it("routes listed and owned workspaces locally and everything else to the cloud", async () => {
    const route = createRenderRouter(db("ok") as never, policy, quiet);
    expect(await route("listed")).toBe("local");
    expect(await route("owned")).toBe("local");
    expect(await route("customer")).toBe("cloud");
    expect(await createRenderRouter(db("ok") as never, null, quiet)("listed")).toBe("cloud");
  });

  it("answers the cloud instead of throwing when the owner lookup fails, so an export never fails on it", async () => {
    await expect(createRenderRouter(db("fail") as never, policy, quiet)("customer")).resolves.toBe("cloud");
    await expect(createRenderRouter(db("fail") as never, policy, quiet)("owned")).resolves.toBe("cloud");
  });

  it("gives up on a slow lookup after its timeout", async () => {
    const started = Date.now();
    await expect(createRenderRouter(db("hang") as never, policy, { ...quiet, timeoutMs: 50 })("owned")).resolves.toBe("cloud");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("caches the owners' workspaces, and keeps the last good answer when a refresh fails", async () => {
    let clock = 0;
    const database = db("ok");
    const route = createRenderRouter(database as never, policy, { ...quiet, ttlMs: 1_000, now: () => clock });
    expect(await route("owned")).toBe("local");
    expect(await route("customer")).toBe("cloud");
    expect(database.user.findMany).toHaveBeenCalledTimes(1);
    clock = 5_000;
    database.user.findMany.mockImplementation(() => Promise.reject(new Error("down")));
    expect(await route("owned")).toBe("local");
  });
});

// Routing and the fallback are SQL (who owns what, conditional moves), so they run against a real,
// migrated Postgres; skipped without DATABASE_URL, as in outbox.test.ts.
describe.skipIf(!process.env.DATABASE_URL)("local render routing (Postgres)", () => {
  const tag = randomUUID().slice(0, 8);
  const email = `owner-${tag}@example.com`;
  let home: string, owned: string, edited: string, listed: string, customer: string;
  let policy: LocalRenderPolicy;
  const serialize = (message: { jobId: string; generation: number }) => JSON.stringify(message);
  const fallbackMs = 10 * 60_000;
  const minutesAgo = (minutes: number, from = new Date()) => new Date(from.getTime() - minutes * 60_000);

  beforeAll(async () => {
    const workspace = (name: string) => prisma.workspace.create({ data: { slug: `test-local-${name}-${tag}`, name } }).then((w) => w.id);
    [home, owned, edited, listed, customer] = await Promise.all(["home", "owned", "edited", "listed", "customer"].map(workspace)) as [string, string, string, string, string];
    const user = await prisma.user.create({ data: { email, name: "Owner", workspaceId: home } });
    const other = await prisma.user.create({ data: { email: `customer-${tag}@example.com`, name: "Customer", workspaceId: customer } });
    await prisma.workspaceMember.createMany({
      data: [
        { userId: user.id, workspaceId: home, role: "OWNER" },
        { userId: user.id, workspaceId: owned, role: "OWNER" },
        // Invited as an editor into someone else's studio: that studio stays on the cloud.
        { userId: user.id, workspaceId: edited, role: "EDITOR" },
        { userId: other.id, workspaceId: customer, role: "OWNER" },
      ],
    });
    policy = { queueUrl: "https://sqs/local", workspaceIds: new Set([listed]), emails: new Set([email]) };
  });

  afterAll(async () => {
    const ids = [home, owned, edited, listed, customer].filter(Boolean);
    const jobs = await prisma.renderJob.findMany({ where: { workspaceId: { in: ids } }, select: { id: true } });
    if (jobs.length) await prisma.outboxMessage.deleteMany({ where: { OR: jobs.map((j) => ({ body: { contains: j.id } })) } });
    await prisma.renderJob.deleteMany({ where: { workspaceId: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `${tag}@example.com` } } });
    await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("routes listed workspaces and the owner's home and owned workspaces to the local queue", async () => {
    expect(new Set(await localRenderWorkspaceIds(prisma, policy))).toEqual(new Set([listed, home, owned]));
    const route = createRenderRouter(prisma, policy);
    expect(await route(home)).toBe("local");
    expect(await route(owned)).toBe("local");
    expect(await route(listed)).toBe("local");
    expect(await route(edited)).toBe("cloud");
    expect(await route(customer)).toBe("cloud");
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
    // The customer's studio is on no list, but this job was sent to the PC (the owner gave the studio away
    // after queueing it, or the list changed while the PC was off).
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
