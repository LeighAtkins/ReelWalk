import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { aiCreditSummary, keyframeHash, makeKeyframeRequest, prisma, reserveKeyframe, keyframeStorageTransaction, type KeyframeSnapshot, type Prisma, type PrismaClient } from "../src";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe.skipIf(!process.env.DATABASE_URL)("keyframe input admission (Postgres)", () => {
  const workspaces: string[] = [];
  let held = 0;
  async function fixture() {
    vi.stubEnv("AI_KEYFRAMES_ENABLED", "true"); vi.stubEnv("GOOGLE_CLOUD_PROJECT", "offline-fixture");
    vi.stubEnv("AI_VIDEO_BUDGET_CENTS", "1000000");
    const row = await prisma.workspace.create({ data: { slug: `keyframe-${randomUUID()}`, name: "Offline keyframe admission", users: { create: { email: `${randomUUID()}@example.test`, name: "Test" } } }, include: { users: true } });
    workspaces.push(row.id);
    const asset = await prisma.mediaAsset.create({ data: { workspaceId: row.id, kind: "IMAGE", objectKey: `fixture/${row.id}/photo.png`, contentType: "image/png", fileName: "fixture.png", sizeBytes: 9n, width: 1, height: 1 } });
    const input = { role: "end" as const, source: { assetId: asset.id, atMs: 0 as const }, move: "shift-right" as const, distanceM: 3, durationSeconds: 4 as const };
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const request = makeKeyframeRequest(input, png);
    const snapshot: KeyframeSnapshot = { model: "gemini-3-pro-image", source: { assetId: asset.id, objectKey: asset.objectKey, originalHash: keyframeHash(png), canonicalKey: "fixture/canonical.png", canonicalHash: keyframeHash(png) }, requestKey: "fixture/request.json", price: { inputPerMillion: 2, outputPerMillion: 120, inputTokenBound: 8192, outputTokenBound: 8192, maximumUsdMicros: 999424, evidence: "offline fixture" } };
    return { actor: { id: row.users[0].id, workspaceId: row.id }, value: { requestId: randomUUID(), input, inputHash: keyframeHash(JSON.stringify(input)), requestHash: keyframeHash(request), snapshot } };
  }
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    if (held) await prisma.aiSpendBudget.update({ where: { id: "vertex-video" }, data: { reservedCents: { decrement: held } } });
    vi.unstubAllEnvs(); await prisma.$disconnect();
  });
  it("serializes simultaneous identical retries with one persistence, credit debit and hold", async () => {
    const { actor, value } = await fixture();
    const persist = vi.fn(async () => {});
    const results = await Promise.all([reserveKeyframe(prisma, actor, value, new Date(), persist), reserveKeyframe(prisma, actor, value, new Date(), persist)]);
    held += 100;
    expect(results[0].id).toBe(results[1].id); expect(persist).toHaveBeenCalledOnce();
    expect((await aiCreditSummary(prisma, actor.workspaceId)).remaining).toBe(1);
    expect(await prisma.aiKeyframe.count({ where: { workspaceId: actor.workspaceId } })).toBe(1);
  });
  it("rolls back credit and hold when preparation fails, allowing the identical request to resume", async () => {
    const { actor, value } = await fixture();
    await expect(reserveKeyframe(prisma, actor, value, new Date(), async () => { throw Error("storage write failed"); })).rejects.toThrow("storage write failed");
    expect((await aiCreditSummary(prisma, actor.workspaceId)).remaining).toBe(2);
    expect(await prisma.aiKeyframe.count({ where: { workspaceId: actor.workspaceId } })).toBe(0);
    await reserveKeyframe(prisma, actor, value, new Date(), async () => {}); held += 100;
    expect((await aiCreditSummary(prisma, actor.workspaceId)).remaining).toBe(1);
  });
  it.each(["receipt", "candidate", "admission"])("keeps deletion behind a delayed %s PUT after the real Prisma transaction expires", async kind => {
    const { actor, value } = await fixture();
    const started = deferred(), release = deferred();
    const objects = new Set<string>();
    const expiring = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => prisma.$transaction(fn, { timeout: 100 }) } as unknown as PrismaClient;
    const persist = async () => {
      started.resolve(); await release.promise;
      objects.add(`${kind}/first`);
      // Admission must drain all remaining canonical/request writes, not only the first delayed PUT.
      if (kind === "admission") { await Promise.resolve(); objects.add("continuity.png"); objects.add("request.json"); }
    };
    const writing = kind === "admission" ? reserveKeyframe(expiring, actor, value, new Date(), persist) : keyframeStorageTransaction(expiring, [actor.workspaceId], async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${actor.workspaceId} FOR UPDATE`;
      await persist();
      await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
    });
    const outcome = writing.then(() => "unexpected success", () => "expired");
    let deletion: Promise<unknown> | undefined;
    try {
      await Promise.race([started.promise, outcome.then(() => { throw Error("Writer failed before reaching PUT"); })]);
      // Prisma aborts/releases its row lock on timeout but may not reject its promise until the callback returns.
      await expect.poll(async () => {
        try { await prisma.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${actor.workspaceId} FOR UPDATE NOWAIT`; }); return true; }
        catch { return false; }
      }).toBe(true);
      let deleting = false;
      deletion = keyframeStorageTransaction(prisma, [actor.workspaceId], async tx => {
        deleting = true; objects.clear();
        await tx.workspace.deleteMany({ where: { id: actor.workspaceId } });
      });
      await expect.poll(async () => {
        const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted) AS blocked`;
        return rows[0].blocked;
      }).toBe(true);
      expect(deleting).toBe(false);
      release.resolve();
      expect(await outcome).toBe("expired"); await deletion;
      expect(objects.size).toBe(0);
      expect(await prisma.workspace.findUnique({ where: { id: actor.workspaceId } })).toBeNull();
    } finally { release.resolve(); await outcome; await deletion; }
  });
});
