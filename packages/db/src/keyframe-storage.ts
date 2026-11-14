import { PrismaPg } from "@prisma/adapter-pg";
import type { Prisma, PrismaClient } from "./generated/prisma/client";

let storageAdapter: ReturnType<PrismaPg["connect"]> | undefined;
function adapter() {
  return storageAdapter ??= new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "postgresql://reelwalk:reelwalk@localhost:5432/reelwalk", max: 2, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 }).connect().catch(error => { storageAdapter = undefined; throw error; });
}

/**
 * Keep private keyframe writes/deletion excluded until external I/O settles, even if Prisma expires its transaction.
 * BEGIN pins the connection on a transaction pooler; session-level advisory locks would not be safe there.
 * A bounded separate pool avoids consuming the Prisma connection needed by the enclosed transaction.
 */
export async function keyframeStorageTransaction<T>(db: PrismaClient, workspaceIds: string[], callback: (tx: Prisma.TransactionClient) => Promise<T>, options = { timeout: 30_000 }): Promise<T> {
  const driver = await adapter();
  let completion: Promise<T> | undefined;
  const client = await driver.underlyingDriver().connect();
  try {
    await client.query("BEGIN");
    // These settings are local to this short-lived lock transaction, never connection/global configuration.
    await client.query("SET LOCAL idle_in_transaction_session_timeout = 0");
    await client.query("SELECT CASE WHEN current_setting('transaction_timeout', true) IS NOT NULL THEN set_config('transaction_timeout', '0', true) END");
    for (const id of [...new Set(workspaceIds)].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`keyframe-storage:${id}`]);
    }
    return await db.$transaction(tx => {
      completion = Promise.resolve().then(() => callback(tx));
      return completion;
    }, options);
  } finally {
    // Prisma can expire its transaction before the callback/PUT finishes. Drain it, including later PUTs.
    await completion?.catch(() => undefined);
    try { await client.query("ROLLBACK"); }
    finally { client.release(true); }
  }
}
