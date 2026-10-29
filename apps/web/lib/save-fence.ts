import { AsyncLocalStorage } from "node:async_hooks";
import type { prisma } from "@reelwalk/db";

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * A condition on every reel save made inside it (ADR 0095): a note's agent
 * saves through the ordinary command path, and the note decides, at the write
 * and in the write's own transaction, whether the save may land (`check`, a
 * reason refuses it) and records what landed (`committed`). The note is
 * locked by `check`, so it cannot expire between the check and the commit.
 */
export type SaveFence = {
  check(tx: Tx): Promise<string | null>;
  committed(tx: Tx, revision: number): Promise<void>;
};

const fences = new AsyncLocalStorage<SaveFence>();

export const withSaveFence = <T>(fence: SaveFence, work: () => Promise<T>): Promise<T> => fences.run(fence, work);

export const currentSaveFence = (): SaveFence | undefined => fences.getStore();
