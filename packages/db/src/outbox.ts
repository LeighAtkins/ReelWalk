import type { Prisma, PrismaClient } from "./generated/prisma/client";

/** Topic of the messages that tell a worker to render a job. */
export const RENDER_JOBS_TOPIC = "render-jobs";

export type OutboxSend = (body: string) => Promise<void>;

export type RelayResult = { sent: number; failed: number };

/** Delay before a message whose send has failed `attempts` times is tried again: 1 s, 2 s, 4 s ... capped. */
export function outboxRetryDelaySeconds(attempts: number, capSeconds = 60): number {
  return Math.min(capSeconds, 2 ** Math.max(0, attempts - 1));
}

/**
 * Records a queue message as part of `tx`. Nothing is sent here: the message
 * exists if and only if the surrounding transaction commits, and
 * `relayOutbox` sends it afterwards.
 */
export async function addToOutbox(tx: Prisma.TransactionClient, topic: string, body: string): Promise<void> {
  await tx.outboxMessage.create({ data: { topic, body } });
}

type PendingRow = { id: string; body: string; attempts: number };

/**
 * Sends the pending messages of one topic, oldest first, at most `limit`.
 *
 * Each message is handled in its own transaction: the row is locked, sent and
 * deleted. `FOR UPDATE SKIP LOCKED` lets several relays (every web and worker
 * process runs one) work side by side without sending the same row twice. If
 * the send fails, the row stays and is tried again later with backoff.
 *
 * A crash after the send but before the commit sends the message again, so
 * delivery is at least once, the same guarantee the queue itself gives.
 */
export async function relayOutbox(
  prisma: PrismaClient,
  options: { topic: string; send: OutboxSend; limit?: number },
): Promise<RelayResult> {
  const { topic, send, limit = 20 } = options;
  const result: RelayResult = { sent: 0, failed: 0 };

  while (result.sent + result.failed < limit) {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<PendingRow[]>`
          SELECT "id", "body", "attempts" FROM "OutboxMessage"
          WHERE "topic" = ${topic} AND "availableAt" <= ${new Date()}
          ORDER BY "createdAt"
          LIMIT 1
          FOR UPDATE SKIP LOCKED`;
        const row = rows[0];
        if (!row) return "empty";

        try {
          await send(row.body);
        } catch (error) {
          const attempts = row.attempts + 1;
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: {
              attempts,
              lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
              availableAt: new Date(Date.now() + outboxRetryDelaySeconds(attempts) * 1000),
            },
          });
          return "failed";
        }
        await tx.outboxMessage.delete({ where: { id: row.id } });
        return "sent";
      },
      // The row lock is held across the send, so allow for a slow queue call.
      // The relay is a background loop, so it can also wait longer than the
      // default 2 s for a pooled connection: on a worker that is rendering,
      // the pool is busy with heartbeats and the default timed out under load.
      { maxWait: 10_000, timeout: 30_000 },
    );
    if (outcome === "empty") break;
    result[outcome] += 1;
  }
  return result;
}
