import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client";
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), dispose: vi.fn() }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class {
  async connect() { return { underlyingDriver: () => ({ connect: async () => ({ query: mocks.query, release: mocks.release }) }), dispose: mocks.dispose }; }
} }));
import { keyframeStorageTransaction } from "../src/keyframe-storage";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => vi.resetAllMocks());
describe("external keyframe I/O exclusion", () => {
  it("drains the complete callback before releasing exclusion even if the DB promise rejects early", async () => {
    const started = deferred(), delayedPut = deferred(); const writes: string[] = [];
    const transaction = vi.fn(fn => { void fn({}); return Promise.reject(Error("transaction expired")); });
    const result = keyframeStorageTransaction({ $transaction: transaction } as unknown as PrismaClient, ["w"], async () => {
      started.resolve(); await delayedPut.promise; writes.push("first.png");
      await Promise.resolve(); writes.push("continuity.png", "request.json");
    }).then(() => "unexpected success", error => error.message);
    await started.promise;
    expect(mocks.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    expect(mocks.release).not.toHaveBeenCalled();
    delayedPut.resolve(); expect(await result).toBe("transaction expired");
    expect(writes).toEqual(["first.png", "continuity.png", "request.json"]);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledWith(true);
  });
  it("takes sorted distinct workspace locks inside BEGIN, compatible with transaction pooling", async () => {
    const transaction = vi.fn(async fn => fn({}));
    expect(await keyframeStorageTransaction({ $transaction: transaction } as unknown as PrismaClient, ["b", "a", "b"], async () => 7)).toBe(7);
    expect(mocks.query.mock.calls[0][0]).toBe("BEGIN");
    const locks = mocks.query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_xact_lock"));
    expect(locks.map(([, args]) => args)).toEqual([["keyframe-storage:a"], ["keyframe-storage:b"]]);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("never starts a writer when the exclusion lock cannot be acquired", async () => {
    mocks.query.mockImplementation(async sql => { if (sql.includes("pg_advisory_xact_lock")) throw Error("lock unavailable"); });
    const transaction = vi.fn();
    await expect(keyframeStorageTransaction({ $transaction: transaction } as unknown as PrismaClient, ["w"], async () => {})).rejects.toThrow("lock unavailable");
    expect(transaction).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalledWith(true);
  });
});
