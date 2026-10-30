import { AsyncLocalStorage } from "node:async_hooks";
import type { prisma } from "@reelwalk/db";

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * A condition on every reel save made inside it (ADR 0095): a note's agent
 * saves through the ordinary command path, and the note decides, in the
 * write's own transaction, whether the save may land and records what landed.
 * Locks are always taken in one order, the note's row and then the reel's:
 *
 *   lock(tx)       locks the note; a reason refuses (the note was stopped)
 *   (the reel's row is locked by the save)
 *   inTime(tx)     with every lock held, right before the write and again
 *                  right after it: a reason refuses (the time is up by
 *                  clock_timestamp(), never the transaction's start), and
 *                  after the write it rolls the save back
 *   committed(tx)  records the new revision with the save
 */
export type SaveFence = {
  lock(tx: Tx): Promise<string | null>;
  inTime(tx: Tx): Promise<string | null>;
  committed(tx: Tx, revision: number): Promise<void>;
};

/** Thrown inside a fenced transaction to roll it back with the fence's reason. */
export class FenceRefused extends Error {}

const fences = new AsyncLocalStorage<SaveFence>();

export const withSaveFence = <T>(fence: SaveFence, work: () => Promise<T>): Promise<T> => fences.run(fence, work);

export const currentSaveFence = (): SaveFence | undefined => fences.getStore();
