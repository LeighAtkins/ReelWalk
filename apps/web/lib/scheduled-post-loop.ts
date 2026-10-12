import { publishDueScheduledPosts } from "./scheduled-posts";

/**
 * The in-process publisher loop: every SCHEDULED_POSTS_TICK_SECONDS (60) a
 * tick claims and advances due posts. One loop per server process; ticks
 * never overlap within a process, and the claim keeps processes apart.
 *
 * On App Runner an instance gets CPU only while it serves a request, so this
 * loop cannot be relied on there; EventBridge calls
 * /api/scheduled-posts/run instead (ADR 0017). SCHEDULED_POSTS_LOOP=off
 * switches the loop off.
 */
const state = globalThis as unknown as { reelwalkScheduledPostLoop?: NodeJS.Timeout };

export function startScheduledPostLoop(): void {
  if (process.env.SCHEDULED_POSTS_LOOP === "off" || state.reelwalkScheduledPostLoop) return;
  const seconds = Math.max(10, Number(process.env.SCHEDULED_POSTS_TICK_SECONDS ?? 60) || 60);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await publishDueScheduledPosts();
    } finally {
      running = false;
    }
  };
  state.reelwalkScheduledPostLoop = setInterval(() => void tick(), seconds * 1000);
  // The loop must not keep a stopping server alive.
  state.reelwalkScheduledPostLoop.unref();
}
