import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The module reads its settings at import time, so each test imports it fresh under its own env.
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const reconcileLocks: unknown[] = [];
  const moveStalledLocalRenders = vi.fn(async () => [] as string[]);
  vi.doMock("@reelwalk/db", async (original) => {
    const actual = await original<typeof import("@reelwalk/db")>();
    return {
      ...actual,
      moveStalledLocalRenders,
      prisma: {
        $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: async () => (reconcileLocks.push(1), [{ locked: true }]) })),
        aiGeneration: { count: async () => 0 },
      },
    };
  });
  const flushOutbox = vi.fn(async () => undefined);
  vi.doMock("./render-jobs", () => ({ flushOutbox }));
  // No AWS here: ECS lists no tasks and accepts every RunTask; the cloud queue holds nothing.
  const ecsSend = vi.spyOn(ECSClient.prototype, "send").mockImplementation((async (command: { input: { count?: number } }) =>
    command instanceof RunTaskCommand ? { tasks: tasks(command.input.count ?? 1) } : { taskArns: [] }) as never);
  vi.spyOn(SQSClient.prototype, "send").mockImplementation((async () => ({ Attributes: {} })) as never);
  const capacity = await import("./render-capacity");
  const runTasks = () => ecsSend.mock.calls.map(([command]) => command).filter((command): command is RunTaskCommand => command instanceof RunTaskCommand);
  return { capacity, moveStalledLocalRenders, flushOutbox, reconcileLocks, runTasks };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@reelwalk/db");
  vi.doUnmock("./render-jobs");
});

const base = { cluster: "reelwalk-renders", taskDefinition: "reelwalk-worker", count: 2, startedBy: "reelwalk-web" };
function tasks(n: number) { return Array.from({ length: n }, (_, i) => ({ taskArn: `arn:task/${i}` })); }

describe("startWorkerTasks", () => {
  it("launches on Fargate Spot and stops there when Spot places every task", async () => {
    const { capacity } = await load({});
    const send = vi.fn(async (_command: RunTaskCommand) => ({ tasks: tasks(2), failures: [] }));
    expect(await capacity.startWorkerTasks({ send } as never, base, { spot: true })).toEqual({ started: 2, spot: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0].input;
    expect(input.capacityProviderStrategy).toEqual([{ capacityProvider: "FARGATE_SPOT", weight: 1 }]);
    expect(input.launchType).toBeUndefined();
    expect(input.count).toBe(2);
  });

  it("starts on-demand Fargate for what Spot could not place", async () => {
    const { capacity } = await load({});
    const send = vi.fn(async (command: RunTaskCommand) =>
      command.input.capacityProviderStrategy?.[0]?.capacityProvider === "FARGATE_SPOT"
        ? { tasks: tasks(1), failures: [{ reason: "Capacity is unavailable at this time. Please try again later or in a different availability zone" }] }
        : { tasks: tasks(command.input.count ?? 1), failures: [] });
    expect(await capacity.startWorkerTasks({ send } as never, base, { spot: true })).toEqual({ started: 2, spot: 1 });
    expect(send.mock.calls[1]![0].input).toMatchObject({ count: 1, capacityProviderStrategy: [{ capacityProvider: "FARGATE", weight: 1 }] });
  });

  it("falls back to on-demand Fargate when the Spot launch is refused outright", async () => {
    const { capacity } = await load({});
    const send = vi.fn(async (command: RunTaskCommand) => {
      if (command.input.capacityProviderStrategy?.[0]?.capacityProvider === "FARGATE_SPOT") throw new Error("The specified capacity provider strategy cannot contain a capacity provider that is not associated with the cluster.");
      return { tasks: tasks(command.input.count ?? 1), failures: [] };
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await capacity.startWorkerTasks({ send } as never, base, { spot: true })).toEqual({ started: 2, spot: 0 });
    expect(send.mock.calls[1]![0].input).toMatchObject({ count: 2, capacityProviderStrategy: [{ capacityProvider: "FARGATE", weight: 1 }] });
  });

  it("uses on-demand Fargate only when Spot is switched off", async () => {
    const { capacity } = await load({});
    const send = vi.fn(async (command: RunTaskCommand) => ({ tasks: tasks(command.input.count ?? 1) }));
    expect(await capacity.startWorkerTasks({ send } as never, base, { spot: false })).toEqual({ started: 2, spot: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input.capacityProviderStrategy).toEqual([{ capacityProvider: "FARGATE", weight: 1 }]);
  });
});

describe("planLaunches", () => {
  it("starts what the queue needs, capped, less what is up or on its way", async () => {
    const { capacity } = await load({});
    expect(capacity.planLaunches({ active: 0, recent: 0, outstanding: 3, atLeastOne: false, maxWorkers: 2, perWorker: 1 })).toBe(2);
    expect(capacity.planLaunches({ active: 1, recent: 0, outstanding: 3, atLeastOne: false, maxWorkers: 2, perWorker: 1 })).toBe(1);
    expect(capacity.planLaunches({ active: 0, recent: 0, outstanding: 0, atLeastOne: true, maxWorkers: 2, perWorker: 1 })).toBe(1);
    expect(capacity.planLaunches({ active: 0, recent: 0, outstanding: 0, atLeastOne: false, maxWorkers: 2, perWorker: 1 })).toBe(0);
  });
});

const ecsEnv = { ECS_CLUSTER: "reelwalk-renders", ECS_WORKER_TASK_DEFINITION: "arn:aws:ecs:us-east-2:1:task-definition/reelwalk-worker", ECS_SUBNETS: "subnet-1" };
const localEnv = { LOCAL_RENDER_QUEUE_URL: "https://sqs/reelwalk-render-jobs-local", LOCAL_RENDER_WORKSPACES: "ws-ours" };

describe("ensureWorkerRunning", () => {
  it("starts no cloud worker for a job routed to the local queue", async () => {
    const { capacity, reconcileLocks } = await load({ ...ecsEnv, ...localEnv });
    await capacity.ensureWorkerRunning("local");
    expect(reconcileLocks).toHaveLength(0);
  });

  it("starts a Spot worker for a cloud job", async () => {
    const { capacity, reconcileLocks, runTasks } = await load({ ...ecsEnv, ...localEnv });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await capacity.ensureWorkerRunning("cloud");
    expect(reconcileLocks).toHaveLength(1);
    expect(runTasks().map((command) => command.input.capacityProviderStrategy?.[0]?.capacityProvider)).toEqual(["FARGATE_SPOT"]);
  });
});

describe("rescueStalledLocalRenders", () => {
  it("does nothing without a local queue", async () => {
    const { capacity, moveStalledLocalRenders } = await load({});
    expect(await capacity.rescueStalledLocalRenders()).toBe(0);
    expect(moveStalledLocalRenders).not.toHaveBeenCalled();
  });

  it("moves stalled local jobs, flushes them to the cloud queue and starts a worker", async () => {
    const { capacity, moveStalledLocalRenders, flushOutbox, reconcileLocks, runTasks } = await load({ ...ecsEnv, ...localEnv, LOCAL_RENDER_FALLBACK_SECONDS: "600" });
    moveStalledLocalRenders.mockResolvedValueOnce(["job-1"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await capacity.rescueStalledLocalRenders()).toBe(1);
    const [, policy] = moveStalledLocalRenders.mock.calls[0] as unknown as [unknown, { fallbackMs: number; queueUrl: string }];
    expect(policy).toMatchObject({ fallbackMs: 600_000, queueUrl: localEnv.LOCAL_RENDER_QUEUE_URL });
    expect(flushOutbox).toHaveBeenCalledTimes(1);
    expect(reconcileLocks).toHaveLength(1);
    expect(runTasks()).toHaveLength(1);
  });

  it("starts nothing when nothing was stalled", async () => {
    const { capacity, flushOutbox, reconcileLocks } = await load({ ...ecsEnv, ...localEnv });
    expect(await capacity.rescueStalledLocalRenders()).toBe(0);
    expect(flushOutbox).not.toHaveBeenCalled();
    expect(reconcileLocks).toHaveLength(0);
  });
});
