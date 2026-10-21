/**
 * Browser side of the background AI requests (lib/ai-jobs.ts): starts one,
 * then checks every two seconds until it has an answer. A dropped check is
 * simply tried again, so a phone changing networks does not lose the work.
 *
 * One call is one user action: it gets one request id (unless the caller
 * brought its own), and a start that never got a response is sent again with
 * the same id, so the server resumes the request instead of paying for a
 * second one (ADR 0049).
 */
export async function runAiJob<T>(url: string, body: unknown, options: { attempts?: number; retryDelayMs?: number } = {}): Promise<T | { ok: false; message: string }> {
  const own = (body as { requestId?: unknown } | null)?.requestId;
  const payload = { ...(body as object), requestId: typeof own === "string" ? own : crypto.randomUUID() };
  const attempts = options.attempts ?? 3;
  let started: { ok: true; jobId: string } | { ok: false; message: string } | null = null;
  let answered = false;
  for (let attempt = 1; attempt <= attempts && !started; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      // A gateway error may have been sent after the request reached the app: ask again with the same id.
      answered = true;
      if (response.status >= 502 && response.status <= 504 && attempt < attempts) throw new Error(`HTTP ${response.status}`);
      started = await response.json();
    } catch {
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 1500) * attempt));
    }
  }
  // No response at all: the request may have arrived and be running. Asking again would be a second request.
  if (!started && !answered) return { ok: false, message: "ReelWalk did not answer, so your request may still be running. Check back in a minute before asking again." };
  if (!started) return { ok: false, message: "Could not reach ReelWalk. Check the connection and try again." };
  if (!started.ok) return started;
  return waitForAiJob<T>(started.jobId);
}

/** Resumes polling an existing request without submitting another paid model call. */
export async function waitForAiJob<T>(jobId: string): Promise<T | { ok: false; message: string }> {
  // A durable job (ADR 0049) is settled by the worker, so the browser can wait longer; it reports state, never age.
  let deadline = Date.now() + 5 * 60_000;
  let misses = 0, extended = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await fetch(`/api/ai-jobs/${jobId}`, { cache: "no-store" });
      const job = (await response.json()) as { status: string; result?: T; error?: string; durable?: boolean; possiblyStale?: boolean };
      misses = 0;
      if (job.durable && !extended) { deadline = Date.now() + 20 * 60_000; extended = true; }
      if (job.status === "DONE") return job.result as T;
      if (job.status === "FAILED" || job.status === "UNRESOLVED") return { ok: false, message: job.error ?? "That did not work. Try again." };
      if (job.possiblyStale) return { ok: false, message: job.error ?? "That took too long. Try again." };
    } catch {
      if (++misses >= 15) return { ok: false, message: "Lost the connection to ReelWalk. Your reel is unchanged; try again." };
    }
  }
  return { ok: false, message: "This is taking longer than usual. It is still saved; check back in a moment rather than asking again." };
}
