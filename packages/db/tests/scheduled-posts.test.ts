import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  advanceScheduledPost,
  afterFailure,
  canTransitionScheduledPost,
  cancelScheduledPost,
  claimDueScheduledPosts,
  containerRecheckDelayMs,
  prisma,
  runScheduledPosts,
  SCHEDULED_POST_STUCK_MS,
  scheduledPostAudio,
  scheduledPostAudioName,
  scheduledPostRetryDelayMs,
  setScheduledPostAudio,
  type ContainerState,
  type ScheduledPostDeps,
} from "../src/index";

const now = new Date("2026-10-13T00:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);

describe("scheduled post transitions", () => {
  it("only moves forward, and only SCHEDULED can be cancelled", () => {
    expect(canTransitionScheduledPost("SCHEDULED", "PUBLISHING")).toBe(true);
    expect(canTransitionScheduledPost("SCHEDULED", "CANCELLED")).toBe(true);
    expect(canTransitionScheduledPost("PUBLISHING", "PUBLISHING")).toBe(true);
    expect(canTransitionScheduledPost("PUBLISHING", "PUBLISHED")).toBe(true);
    expect(canTransitionScheduledPost("PUBLISHING", "FAILED")).toBe(true);
    expect(canTransitionScheduledPost("PUBLISHING", "CANCELLED")).toBe(false);
    expect(canTransitionScheduledPost("PUBLISHED", "PUBLISHING")).toBe(false);
    expect(canTransitionScheduledPost("FAILED", "SCHEDULED")).toBe(false);
    expect(canTransitionScheduledPost("CANCELLED", "PUBLISHING")).toBe(false);
  });

  it("retries a transient error three times with growing waits, then fails", () => {
    const transient = { message: "Service temporarily unavailable", transient: true };
    const first = afterFailure(0, transient, now);
    expect(first).toEqual({ status: "PUBLISHING", attempts: 1, error: transient.message, nextCheckAt: at(60_000) });
    expect(afterFailure(1, transient, now)).toMatchObject({ status: "PUBLISHING", attempts: 2, nextCheckAt: at(120_000) });
    expect(afterFailure(2, transient, now)).toMatchObject({ status: "PUBLISHING", attempts: 3, nextCheckAt: at(240_000) });
    expect(afterFailure(3, transient, now)).toEqual({ status: "FAILED", attempts: 4, error: `${transient.message} (gave up after 4 tries)` });
    expect([1, 2, 3].map(scheduledPostRetryDelayMs)).toEqual([60_000, 120_000, 240_000]);
  });

  it("fails a permanent error straight away", () => {
    expect(afterFailure(0, { message: "Invalid OAuth access token.", transient: false }, now)).toEqual({
      status: "FAILED",
      attempts: 1,
      error: "Invalid OAuth access token.",
    });
  });

  it("checks a processing container less often the longer it takes", () => {
    expect(containerRecheckDelayMs(0)).toBe(20_000);
    expect(containerRecheckDelayMs(120_000)).toBe(60_000);
    expect(containerRecheckDelayMs(60 * 60_000)).toBe(5 * 60_000);
  });

  it("sends a post's chosen sound, and nothing when it has none", () => {
    expect(scheduledPostAudio({ audioId: null, audioVolume: null, videoVolume: null })).toBeNull();
    expect(scheduledPostAudio({ audioId: "123", audioVolume: 100, videoVolume: 35 })).toEqual({ audioId: "123", audioVolume: 100, videoVolume: 35 });
    expect(scheduledPostAudio({ audioId: "123", audioVolume: null, videoVolume: null })).toEqual({ audioId: "123", audioVolume: 100, videoVolume: 0 });
    expect(scheduledPostAudioName({ audioId: "123", audioTitle: "Song", audioArtist: "Band" })).toBe('"Song · Band"');
    expect(scheduledPostAudioName({ audioId: "123", audioTitle: null, audioArtist: null })).toBe('"123"');
  });
});

// Claims are a locking rule in SQL, so they are tested against a real,
// migrated Postgres, like the outbox. Skipped without DATABASE_URL; CI has one.
describe.skipIf(!process.env.DATABASE_URL)("scheduled posts (Postgres)", () => {
  // The publisher claims every due row in the table, so these tests use dates
  // far in the past (never touched by real posts) and clean up after themselves.
  const base = new Date("2000-01-01T00:00:00Z");
  const time = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
  let workspaceId = "";
  let renderJobId = "";

  beforeAll(async () => {
    const workspace = await prisma.workspace.create({ data: { slug: `test-sched-${randomUUID()}`, name: "Scheduling test" } });
    workspaceId = workspace.id;
    renderJobId = (await prisma.renderJob.create({ data: { workspaceId, kind: "REEL", status: "SUCCEEDED" } })).id;
  });

  // A tick advances every due row, so no test may leave rows for the next one.
  afterEach(async () => {
    await prisma.scheduledPost.deleteMany({ where: { workspaceId } });
  });

  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  const schedule = (publishAt: Date) => prisma.scheduledPost.create({ data: { workspaceId, renderJobId, caption: "Open house", publishAt } });
  const reload = (id: string) => prisma.scheduledPost.findUniqueOrThrow({ where: { id } });
  // Only this test's rows: other tests may have due rows of their own.
  const mine = (claims: { id: string; claimToken: string }[], ids: string[]) => claims.filter((claim) => ids.includes(claim.id));

  function fakeInstagram(states: ContainerState[] = ["FINISHED"]) {
    const calls: string[] = [];
    const deps: ScheduledPostDeps = {
      prepare: async () => ({ igUserId: "17841400000000000", token: "token", videoUrl: "https://media.example/reel.mp4" }),
      createContainer: vi.fn(async (input) => {
        calls.push(`create ${input.coverMs}${input.audio ? ` audio ${input.audio.audioId} ${input.audio.audioVolume}/${input.audio.videoVolume}` : ""}`);
        return `1790000000000000${calls.length}`;
      }),
      containerStatus: vi.fn(async () => {
        const status = states.length > 1 ? states.shift()! : states[0]!;
        calls.push(`status ${status}`);
        return { status, detail: status === "ERROR" ? "Unsupported video codec" : null };
      }),
      publish: vi.fn(async () => {
        calls.push("publish");
        return { mediaId: "18000000000000001", permalink: "https://www.instagram.com/reel/abc/" };
      }),
      classify: (error) => ({ message: error instanceof Error ? error.message : String(error), transient: true }),
      onFailed: vi.fn(async () => undefined),
    };
    return { deps, calls };
  }

  it("claims a due post exactly once even when two instances race", async () => {
    const post = await schedule(time(0));
    const [a, b] = await Promise.all([claimDueScheduledPosts(prisma, { now: time(1), limit: 50 }), claimDueScheduledPosts(prisma, { now: time(1), limit: 50 })]);
    const winners = [...(mine(a, [post.id])), ...(mine(b, [post.id]))];
    expect(winners).toHaveLength(1);
    const row = await reload(post.id);
    expect(row.status).toBe("PUBLISHING");
    expect(row.claimToken).toBe(winners[0]!.claimToken);
    expect(row.nextCheckAt).toEqual(new Date(time(1).getTime() + SCHEDULED_POST_STUCK_MS));
  });

  it("does not claim a post before its time, or a cancelled one", async () => {
    const early = await schedule(time(10));
    const cancelled = await schedule(time(0));
    expect(await cancelScheduledPost(prisma, { id: cancelled.id, workspaceId })).toBe(true);
    const claims = await claimDueScheduledPosts(prisma, { now: time(5), limit: 50 });
    expect(mine(claims, [early.id, cancelled.id])).toEqual([]);
    expect((await reload(cancelled.id)).status).toBe("CANCELLED");
  });

  it("cannot cancel a post another workspace owns, or one already publishing", async () => {
    const post = await schedule(time(0));
    expect(await cancelScheduledPost(prisma, { id: post.id, workspaceId: "someone-else" })).toBe(false);
    await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 });
    expect(await cancelScheduledPost(prisma, { id: post.id, workspaceId })).toBe(false);
    expect((await reload(post.id)).status).toBe("PUBLISHING");
  });

  it("creates the container, waits for processing across ticks, then publishes", async () => {
    const post = await schedule(time(0));
    const { deps, calls } = fakeInstagram(["IN_PROGRESS", "FINISHED"]);

    // Tick 1: container created, nothing published yet.
    const [claim1] = mine(await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, claim1!, deps, time(1))).toBe("waiting");
    let row = await reload(post.id);
    expect(row.containerId).toMatch(/^179/);
    expect(row.nextCheckAt).toEqual(new Date(time(1).getTime() + 20_000));

    // Not due again until the recheck time.
    expect(mine(await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 }), [post.id])).toEqual([]);

    // Tick 2: still processing.
    const [claim2] = mine(await claimDueScheduledPosts(prisma, { now: time(2), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, claim2!, deps, time(2))).toBe("waiting");

    // Tick 3: finished, so published.
    const [claim3] = mine(await claimDueScheduledPosts(prisma, { now: time(4), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, claim3!, deps, time(4))).toBe("published");
    row = await reload(post.id);
    expect(row).toMatchObject({ status: "PUBLISHED", mediaId: "18000000000000001", permalink: "https://www.instagram.com/reel/abc/", error: null });
    expect(calls).toEqual(["create 700", "status IN_PROGRESS", "status FINISHED", "publish"]);
  });

  it("a stale claim cannot write once another instance has taken the post over", async () => {
    const post = await schedule(time(0));
    const [stale] = mine(await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 }), [post.id]);
    // The first instance stalls past the 15 minute lease; another takes over.
    const later = new Date(time(1).getTime() + SCHEDULED_POST_STUCK_MS + 1000);
    const [fresh] = mine(await claimDueScheduledPosts(prisma, { now: later, limit: 50 }), [post.id]);
    expect(fresh).toBeDefined();
    expect(fresh!.claimToken).not.toBe(stale!.claimToken);

    const { deps } = fakeInstagram();
    expect(await advanceScheduledPost(prisma, stale!, deps, later)).toBe("lost");
    expect(deps.createContainer).not.toHaveBeenCalled();
    expect(await advanceScheduledPost(prisma, fresh!, deps, later)).toBe("waiting");
  });

  it("retries a failed container with a new one, and fails with a notice after three retries", async () => {
    const post = await schedule(time(0));
    const { deps } = fakeInstagram(["ERROR"]);
    let minute = 1;
    const tick = async () => {
      minute += 10;
      return runScheduledPosts(prisma, deps, { now: () => time(minute), limit: 50 });
    };
    // create, ERROR (retry 1), create, ERROR (retry 2), create, ERROR (retry 3), create, ERROR -> FAILED
    for (let i = 0; i < 8; i++) await tick();
    const row = await reload(post.id);
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(4);
    expect(row.error).toMatch(/Unsupported video codec/);
    expect(deps.createContainer).toHaveBeenCalledTimes(4);
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.onFailed).toHaveBeenCalledTimes(1);
  });

  it("a mailer that throws does not stop the post being marked FAILED", async () => {
    const post = await schedule(time(0));
    const { deps } = fakeInstagram();
    deps.prepare = async () => "Instagram is no longer connected.";
    deps.onFailed = async () => {
      throw new Error("SES is down");
    };
    const [claim] = mine(await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, claim!, deps, time(1))).toBe("failed");
    expect(await reload(post.id)).toMatchObject({ status: "FAILED", attempts: 1, error: "Instagram is no longer connected." });
  });

  it("does not publish twice when the publish answer was lost", async () => {
    const post = await schedule(time(0));
    const { deps } = fakeInstagram(["FINISHED", "PUBLISHED"]);
    deps.publish = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const [c1] = mine(await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, c1!, deps, time(1))).toBe("waiting");
    const [c2] = mine(await claimDueScheduledPosts(prisma, { now: time(2), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, c2!, deps, time(2))).toBe("retrying");
    const [c3] = mine(await claimDueScheduledPosts(prisma, { now: time(5), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, c3!, deps, time(5))).toBe("published");
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.createContainer).toHaveBeenCalledTimes(1);
  });

  it("attaches the chosen sound when the container is created", async () => {
    const post = await prisma.scheduledPost.create({
      data: { workspaceId, renderJobId, caption: "Open house", publishAt: time(0), audioId: "555", audioTitle: "Song", audioArtist: "Band", audioVolume: 100, videoVolume: 35 },
    });
    const { deps, calls } = fakeInstagram();
    const [claim] = mine(await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, claim!, deps, time(1))).toBe("waiting");
    expect(calls).toEqual(["create 700 audio 555 100/35"]);
  });

  it("fails, naming the sound, when Instagram refuses the post with it attached", async () => {
    const post = await prisma.scheduledPost.create({
      data: { workspaceId, renderJobId, caption: "Open house", publishAt: time(0), audioId: "555", audioTitle: "Song", audioArtist: "Band", audioVolume: 100, videoVolume: 0 },
    });
    const { deps } = fakeInstagram();
    deps.createContainer = vi.fn(async () => {
      throw new Error("The audio is not available.");
    });
    deps.classify = (error) => ({ message: error instanceof Error ? error.message : String(error), transient: false });
    const [claim] = mine(await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, claim!, deps, time(1))).toBe("failed");
    const row = await reload(post.id);
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain('"Song · Band"');
    expect(row.error).toContain("The audio is not available.");
    expect(deps.createContainer).toHaveBeenCalledTimes(1);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("changes or removes the sound only while the post is waiting", async () => {
    const post = await schedule(time(0));
    const audio = { audioId: "777", title: "Song", artist: null, audioVolume: 100, videoVolume: 0 };
    expect(await setScheduledPostAudio(prisma, { id: post.id, workspaceId: "someone-else", audio })).toBe(false);
    expect(await setScheduledPostAudio(prisma, { id: post.id, workspaceId, audio })).toBe(true);
    expect(await reload(post.id)).toMatchObject({ audioId: "777", audioTitle: "Song", audioArtist: null, audioVolume: 100, videoVolume: 0 });
    expect(await setScheduledPostAudio(prisma, { id: post.id, workspaceId, audio: null })).toBe(true);
    expect(await reload(post.id)).toMatchObject({ audioId: null, audioTitle: null, audioVolume: null, videoVolume: null });
    await claimDueScheduledPosts(prisma, { now: time(1), limit: 50 });
    expect(await setScheduledPostAudio(prisma, { id: post.id, workspaceId, audio })).toBe(false);
  });

  it("fails rather than posts a day late", async () => {
    const post = await schedule(time(0));
    const { deps } = fakeInstagram();
    const late = time(25 * 60);
    const [claim] = mine(await claimDueScheduledPosts(prisma, { now: late, limit: 50 }), [post.id]);
    expect(await advanceScheduledPost(prisma, claim!, deps, late)).toBe("failed");
    expect((await reload(post.id)).error).toMatch(/more than a day/);
    expect(deps.createContainer).not.toHaveBeenCalled();
  });
});
