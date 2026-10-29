import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_RENDER_JOBS_TOPIC,
  localRenderPolicyFromEnv,
  localRenderWorkspaceIds,
  moveStalledLocalRenders,
  prisma,
  RENDER_JOBS_TOPIC,
  renderJobsTopic,
  renderRouteFor,
  type LocalRenderPolicy,
} from "../src/index";

describe("localRenderPolicyFromEnv", () => {
  it("is off without a queue, or with nobody on the list", () => {
    expect(localRenderPolicyFromEnv({})).toBeNull();
    expect(localRenderPolicyFromEnv({ LOCAL_RENDER_WORKSPACES: "ws-1" })).toBeNull();
    expect(localRenderPolicyFromEnv({ LOCAL_RENDER_QUEUE_URL: "https://sqs/local", LOCAL_RENDER_WORKSPACES: " ", LOCAL_RENDER_EMAILS: "" })).toBeNull();
  });

  it("reads comma or space separated lists, lower-cases emails, and waits ten minutes by default", () => {
    const policy = localRenderPolicyFromEnv({
      LOCAL_RENDER_QUEUE_URL: "https://sqs/local",
      LOCAL_RENDER_WORKSPACES: "ws-1, ws-2  ws-3",
      LOCAL_RENDER_EMAILS: "Leigh@Example.com",
    });
    expect(policy).toEqual({
      queueUrl: "https://sqs/local",
      workspaceIds: new Set(["ws-1", "ws-2", "ws-3"]),
      emails: new Set(["leigh@example.com"]),
      fallbackMs: 600_000,
    });
  });

  it("takes the fallback from LOCAL_RENDER_FALLBACK_SECONDS and ignores nonsense", () => {
    const env = { LOCAL_RENDER_QUEUE_URL: "q", LOCAL_RENDER_WORKSPACES: "ws" };
    expect(localRenderPolicyFromEnv({ ...env, LOCAL_RENDER_FALLBACK_SECONDS: "90" })?.fallbackMs).toBe(90_000);
    expect(localRenderPolicyFromEnv({ ...env, LOCAL_RENDER_FALLBACK_SECONDS: "soon" })?.fallbackMs).toBe(600_000);
    expect(localRenderPolicyFromEnv({ ...env, LOCAL_RENDER_FALLBACK_SECONDS: "0" })?.fallbackMs).toBe(600_000);
  });

  it("maps a route to its outbox topic", () => {
    expect(renderJobsTopic("local")).toBe(LOCAL_RENDER_JOBS_TOPIC);
    expect(renderJobsTopic("cloud")).toBe(RENDER_JOBS_TOPIC);
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
    policy = { queueUrl: "https://sqs/local", workspaceIds: new Set([listed]), emails: new Set([email]), fallbackMs: 10 * 60_000 };
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
    expect(await renderRouteFor(prisma, policy, home)).toBe("local");
    expect(await renderRouteFor(prisma, policy, owned)).toBe("local");
    expect(await renderRouteFor(prisma, policy, listed)).toBe("local");
    expect(await renderRouteFor(prisma, policy, edited)).toBe("cloud");
    expect(await renderRouteFor(prisma, policy, customer)).toBe("cloud");
    expect(await renderRouteFor(prisma, null, home)).toBe("cloud");
  });

  /** A job whose row says it was queued (or last heartbeat) `minutes` ago. */
  async function job(workspaceId: string, status: "QUEUED" | "RUNNING" | "SUCCEEDED", minutes: number, heartbeatMinutes?: number) {
    const created = await prisma.renderJob.create({ data: { workspaceId, kind: "REEL", status, caption: tag, generation: 2 } });
    const at = minutesAgo(minutes);
    // updatedAt is @updatedAt, so it is backdated in SQL.
    await prisma.$executeRaw`UPDATE "RenderJob" SET "updatedAt" = ${at}, "heartbeatAt" = ${heartbeatMinutes === undefined ? null : minutesAgo(heartbeatMinutes)} WHERE "id" = ${created.id}`;
    return created.id;
  }

  it("moves only local jobs left unclaimed, or with a dead heartbeat, past the fallback, to the cloud queue under a new generation", async () => {
    const waited = await job(home, "QUEUED", 11);
    const fresh = await job(home, "QUEUED", 2);
    const dead = await job(owned, "RUNNING", 30, 12);
    const alive = await job(owned, "RUNNING", 30, 0.2);
    const done = await job(home, "SUCCEEDED", 60);
    const cloud = await job(customer, "QUEUED", 30);

    const moved = await moveStalledLocalRenders(prisma, policy, { serialize });
    expect(new Set(moved)).toEqual(new Set([waited, dead]));

    const rows = await prisma.renderJob.findMany({ where: { id: { in: [waited, fresh, dead, alive, done, cloud] } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [waited, dead]) expect(byId.get(id)).toMatchObject({ status: "QUEUED", generation: 3, heartbeatAt: null, progress: 0 });
    expect(byId.get(fresh)).toMatchObject({ status: "QUEUED", generation: 2 });
    expect(byId.get(alive)).toMatchObject({ status: "RUNNING", generation: 2 });
    expect(byId.get(done)).toMatchObject({ status: "SUCCEEDED", generation: 2 });
    expect(byId.get(cloud)).toMatchObject({ status: "QUEUED", generation: 2 });

    // The new messages are on the cloud topic; the local queue's old ones now name a stale generation.
    const outbox = await prisma.outboxMessage.findMany({ where: { body: { contains: waited } } });
    expect(outbox.map((row) => [row.topic, JSON.parse(row.body)])).toEqual([[RENDER_JOBS_TOPIC, { jobId: waited, generation: 3 }]]);

    // Just moved, so not moved again on the next sweep.
    expect(await moveStalledLocalRenders(prisma, policy, { serialize })).toEqual([]);
  });

  it("leaves a job a local worker claims at the same moment with that worker", async () => {
    const racing = await job(home, "QUEUED", 15);
    const original = prisma.$transaction.bind(prisma);
    // The local worker's claim lands between the sweep's read and its conditional write.
    const spy = async (fn: Parameters<typeof prisma.$transaction>[0]) => {
      await prisma.renderJob.update({ where: { id: racing }, data: { status: "RUNNING", heartbeatAt: new Date(), attempt: { increment: 1 } } });
      return original(fn as never);
    };
    const db = { user: prisma.user, workspaceMember: prisma.workspaceMember, renderJob: prisma.renderJob, $transaction: spy } as unknown as typeof prisma;
    const moved = await moveStalledLocalRenders(db, policy, { serialize });
    expect(moved).not.toContain(racing);
    expect(await prisma.renderJob.findUniqueOrThrow({ where: { id: racing } })).toMatchObject({ status: "RUNNING", generation: 2 });
    expect(await prisma.outboxMessage.count({ where: { body: { contains: racing } } })).toBe(0);
  });
});
