/**
 * Browser side of the background AI requests (lib/ai-jobs.ts): starts one,
 * then checks every two seconds until it has an answer. A dropped check is
 * simply tried again, so a phone changing networks does not lose the work.
 */
export async function runAiJob<T>(url: string, body: unknown): Promise<T | { ok: false; message: string }> {
  let started: { ok: true; jobId: string } | { ok: false; message: string };
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    started = await response.json();
  } catch {
    return { ok: false, message: "Could not reach ReelWalk. Check the connection and try again." };
  }
  if (!started.ok) return started;
  const deadline = Date.now() + 5 * 60_000;
  let misses = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await fetch(`/api/ai-jobs/${started.jobId}`, { cache: "no-store" });
      const job = (await response.json()) as { status: string; result?: T; error?: string };
      misses = 0;
      if (job.status === "DONE") return job.result as T;
      if (job.status === "FAILED") return { ok: false, message: job.error ?? "That did not work. Try again." };
    } catch {
      if (++misses >= 15) return { ok: false, message: "Lost the connection to ReelWalk. Your reel is unchanged; try again." };
    }
  }
  return { ok: false, message: "That took too long. Try again." };
}
