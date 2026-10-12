/**
 * Runs once when a Next.js server process starts. Starts the scheduled
 * Instagram post publisher loop (ADR 0017) in the Node.js runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` loads this file too; only a serving process should publish.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startScheduledPostLoop } = await import("./lib/scheduled-post-loop");
  startScheduledPostLoop();
}
