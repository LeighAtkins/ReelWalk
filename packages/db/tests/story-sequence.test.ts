import { describe, expect, it } from "vitest";
import type { PrismaClient, RenderJobStatus, ScheduledPost } from "../src/generated/prisma/client";
import { cancelScheduledPost, renderGate, runScheduledPosts, storyGate, STORY_RENDER_TIMEOUT_MS, STORY_WAIT_MS, type ScheduledPostDeps } from "../src/scheduled-posts";

/**
 * The reel-then-story sequence (ADR 0065), run against an in-memory stand-in
 * for the two tables the publisher touches and a pretend Instagram that
 * records every call. No network, no Postgres: this is the dry run the
 * publisher's order and idempotency are judged by. The claim's SQL locking
 * is covered by scheduled-posts.test.ts against a real database.
 */

type Row = Record<string, unknown>;

/** Enough of Prisma's `where` for the publisher's queries: equality, null, lte, in, OR. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((branch) => matches(row, branch));
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (typeof condition === "object") {
      const c = condition as { lte?: Date; in?: unknown[]; not?: unknown };
      if (c.lte !== undefined) return value instanceof Date && value.getTime() <= c.lte.getTime();
      if (c.in !== undefined) return c.in.includes(value);
      if (c.not !== undefined) return value !== c.not;
      throw new Error(`fake prisma: unsupported condition on ${key}: ${JSON.stringify(condition)}`);
    }
    return value === condition;
  });
}

function table(rows: Row[]) {
  const sorted = (args: { orderBy?: Record<string, "asc" | "desc"> }) => {
    const [[key, direction] = ["id", "asc"]] = Object.entries(args.orderBy ?? {});
    return [...rows].sort((a, b) => {
      const x = a[key] instanceof Date ? (a[key] as Date).getTime() : String(a[key]);
      const y = b[key] instanceof Date ? (b[key] as Date).getTime() : String(b[key]);
      return (x < y ? -1 : x > y ? 1 : 0) * (direction === "desc" ? -1 : 1);
    });
  };
  return {
    rows,
    findMany: async (args: { where?: Row; orderBy?: Record<string, "asc" | "desc">; take?: number }) =>
      sorted(args).filter((row) => matches(row, args.where ?? {})).slice(0, args.take ?? Infinity),
    findFirst: async (args: { where?: Row }) => rows.find((row) => matches(row, args.where ?? {})) ?? null,
    findUnique: async (args: { where: Row }) => rows.find((row) => matches(row, args.where)) ?? null,
    updateMany: async (args: { where: Row; data: Row }) => {
      const hits = rows.filter((row) => matches(row, args.where));
      for (const row of hits) Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: hits.length };
    },
  };
}

const t0 = new Date("2026-10-22T09:00:00Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

function post(partial: Partial<ScheduledPost> & { id: string; kind: "REEL" | "STORY"; renderJobId: string }): Row {
  return {
    workspaceId: "ws",
    createdById: null,
    afterPostId: null,
    caption: "",
    coverMs: 700,
    audioId: null,
    audioTitle: null,
    audioArtist: null,
    audioVolume: null,
    videoVolume: null,
    aiGenerated: true,
    publishAt: t0,
    status: "SCHEDULED",
    attempts: 0,
    error: null,
    claimToken: null,
    nextCheckAt: null,
    containerId: null,
    containerAt: null,
    mediaId: null,
    permalink: null,
    publishedAt: null,
    createdAt: t0,
    updatedAt: t0,
    ...partial,
  };
}

/** A pretend Instagram: containers finish on their second look; `publishFails` makes one publish call lose its answer after going through. */
function instagram(options: { publishFails?: string[] } = {}) {
  const calls: { call: string; kind?: string; container?: string }[] = [];
  const status = new Map<string, "IN_PROGRESS" | "FINISHED" | "PUBLISHED">();
  const published: string[] = [];
  const unanswered = new Set(options.publishFails ?? []);
  let next = 1;
  const deps: ScheduledPostDeps = {
    prepare: async (row) => ({ igUserId: "ig", token: "tok", videoUrl: `https://cdn.example/${row.renderJobId}.mp4` }),
    createContainer: async (input) => {
      const id = `${input.kind === "STORY" ? "story" : "reel"}-container-${next++}`;
      calls.push({ call: "create", kind: input.kind, container: id });
      status.set(id, "IN_PROGRESS");
      return id;
    },
    containerStatus: async (containerId) => {
      calls.push({ call: "status", container: containerId });
      const current = status.get(containerId)!;
      if (current === "IN_PROGRESS") status.set(containerId, "FINISHED");
      return { status: current, detail: null };
    },
    publish: async (_igUserId, containerId) => {
      calls.push({ call: "publish", container: containerId });
      // Instagram publishes it either way; what differs is whether the answer arrives.
      published.push(containerId);
      status.set(containerId, "PUBLISHED");
      if (unanswered.delete(containerId)) throw new Error("socket hang up");
      return { mediaId: `media-${containerId}`, permalink: `https://instagram.com/p/${containerId}` };
    },
    classify: (error) => ({ message: error instanceof Error ? error.message : String(error), transient: true }),
  };
  return { deps, calls, published };
}

describe("reel then story", () => {
  it("creates, polls and publishes the reel, then the story, and a lost publish answer does not publish twice", async () => {
    const posts = table([
      post({ id: "reel", kind: "REEL", renderJobId: "reel-job", caption: "Villa" }),
      post({ id: "story", kind: "STORY", renderJobId: "story-job", afterPostId: "reel" }),
    ]);
    const jobs = table([
      { id: "reel-job", status: "SUCCEEDED", error: null },
      { id: "story-job", status: "RUNNING", error: null },
    ]);
    const prisma = { scheduledPost: posts, renderJob: jobs } as unknown as PrismaClient;
    const ig = instagram({ publishFails: ["reel-container-1"] });
    const tick = (seconds: number) => runScheduledPosts(prisma, ig.deps, { now: () => at(seconds) });
    const row = (id: string) => posts.rows.find((r) => r.id === id)!;

    // Both are due. The reel's container is made; the story waits for the reel.
    expect(await tick(0)).toMatchObject({ claimed: 2, waiting: 2 });
    expect(row("reel")).toMatchObject({ status: "PUBLISHING", containerId: "reel-container-1" });
    expect(row("story")).toMatchObject({ status: "PUBLISHING", containerId: null, nextCheckAt: at(STORY_WAIT_MS / 1000) });

    // The reel is still processing; the story is not due yet.
    expect(await tick(20)).toMatchObject({ claimed: 1, waiting: 1 });
    expect(ig.calls.filter((c) => c.call === "status")).toHaveLength(1);

    // Finished: the publish call goes through but its answer is lost, so the reel retries with its container kept.
    expect(await tick(45)).toMatchObject({ claimed: 2, retrying: 1, waiting: 1 });
    expect(row("reel")).toMatchObject({ status: "PUBLISHING", attempts: 1, containerId: "reel-container-1", error: "socket hang up" });
    expect(ig.published).toEqual(["reel-container-1"]);

    // The retry finds the container PUBLISHED: done, without a second publish call. The story's cut is still rendering.
    expect(await tick(110)).toMatchObject({ claimed: 2, published: 1, waiting: 1 });
    expect(row("reel")).toMatchObject({ status: "PUBLISHED", publishedAt: at(110) });
    expect(ig.calls.filter((c) => c.call === "publish")).toHaveLength(1);
    expect(row("story")).toMatchObject({ status: "PUBLISHING", containerId: null });
    expect(ig.calls.filter((c) => c.kind === "STORY")).toHaveLength(0);

    // The cut is ready: the story's container is made, then published on the next look.
    jobs.rows[1].status = "SUCCEEDED";
    expect(await tick(145)).toMatchObject({ claimed: 1, waiting: 1 });
    expect(row("story")).toMatchObject({ containerId: "story-container-2" });
    expect(await tick(170)).toMatchObject({ claimed: 1, waiting: 1 });
    expect(await tick(200)).toMatchObject({ claimed: 1, published: 1 });
    expect(row("story")).toMatchObject({ status: "PUBLISHED", mediaId: "media-story-container-2" });

    // The whole sequence, in order: the story's container was not made before the reel was published.
    expect(ig.calls.map((c) => `${c.call}${c.kind ? `:${c.kind}` : ""}`)).toEqual([
      "create:REEL",
      "status",
      "status",
      "publish",
      "status",
      "create:STORY",
      "status",
      "status",
      "publish",
    ]);
    expect(ig.published).toEqual(["reel-container-1", "story-container-2"]);
    // A tick with nothing due does nothing.
    expect(await tick(300)).toMatchObject({ claimed: 0 });
  });

  it("fails the story when its reel is not posted, without touching Instagram", async () => {
    const posts = table([
      post({ id: "reel", kind: "REEL", renderJobId: "reel-job", status: "FAILED", error: "Invalid OAuth access token." }),
      post({ id: "story", kind: "STORY", renderJobId: "story-job", afterPostId: "reel" }),
    ]);
    const jobs = table([{ id: "story-job", status: "SUCCEEDED", error: null }]);
    const prisma = { scheduledPost: posts, renderJob: jobs } as unknown as PrismaClient;
    const ig = instagram();
    expect(await runScheduledPosts(prisma, ig.deps, { now: () => t0 })).toMatchObject({ claimed: 1, failed: 1 });
    expect(posts.rows[1]).toMatchObject({ status: "FAILED", error: "The reel this story follows was not posted, so the story was not posted either." });
    expect(ig.calls).toEqual([]);
  });

  it("fails a story whose cut never rendered, and a cancelled reel cancels the story waiting for it", async () => {
    const posts = table([
      post({ id: "reel", kind: "REEL", renderJobId: "reel-job", status: "PUBLISHED" }),
      post({ id: "story", kind: "STORY", renderJobId: "story-job", afterPostId: "reel" }),
    ]);
    const jobs = table([{ id: "story-job", status: "FAILED", error: "Chrome crashed" }]);
    const prisma = { scheduledPost: posts, renderJob: jobs } as unknown as PrismaClient;
    const ig = instagram();
    expect(await runScheduledPosts(prisma, ig.deps, { now: () => t0 })).toMatchObject({ failed: 1 });
    expect(posts.rows[1]).toMatchObject({ status: "FAILED", error: "The story cut did not render: Chrome crashed" });

    const later = table([
      post({ id: "reel2", kind: "REEL", renderJobId: "reel-job" }),
      post({ id: "story2", kind: "STORY", renderJobId: "story-job", afterPostId: "reel2" }),
    ]);
    expect(await cancelScheduledPost({ scheduledPost: later } as unknown as PrismaClient, { id: "reel2", workspaceId: "ws" })).toBe(true);
    expect(later.rows.map((r) => r.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(await cancelScheduledPost({ scheduledPost: later } as unknown as PrismaClient, { id: "reel2", workspaceId: "ws" })).toBe(false);
  });
});

describe("gates", () => {
  it("a story goes only after a published reel", () => {
    expect(storyGate("PUBLISHED")).toEqual({ go: true });
    expect(storyGate("SCHEDULED")).toEqual({ go: false, wait: true });
    expect(storyGate("PUBLISHING")).toEqual({ go: false, wait: true });
    expect(storyGate("FAILED")).toMatchObject({ go: false, wait: false });
    expect(storyGate("CANCELLED")).toMatchObject({ go: false, wait: false, error: expect.stringMatching(/cancelled/) });
    expect(storyGate(null)).toMatchObject({ go: false, wait: false });
  });

  it("a post waits for its video to render, for an hour at most", () => {
    const job = (status: RenderJobStatus) => ({ status, error: null });
    expect(renderGate(job("SUCCEEDED"), 0)).toEqual({ go: true });
    expect(renderGate(job("QUEUED"), 0)).toEqual({ go: false, wait: true });
    expect(renderGate(job("RUNNING"), STORY_RENDER_TIMEOUT_MS)).toEqual({ go: false, wait: true });
    expect(renderGate(job("RUNNING"), STORY_RENDER_TIMEOUT_MS + 1)).toMatchObject({ go: false, wait: false, error: expect.stringMatching(/hour/) });
    expect(renderGate(job("FAILED"), 0)).toMatchObject({ go: false, wait: false });
    expect(renderGate(null, 0)).toMatchObject({ go: false, wait: false, error: expect.stringMatching(/gone/) });
  });
});
