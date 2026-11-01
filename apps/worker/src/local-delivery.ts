import { isAiStepMessage, parseRenderJobMessage, type RenderJobMessage } from "@reelwalk/core";
import type { Delivery, Outcome } from "./handler";
import type { HeavyLock, ReleaseHeavyLock } from "./heavy-lock";

/**
 * A local worker's delivery (ADR 0094): wait for the shared-PC heavy lock
 * BEFORE claiming the job, for at most `waitMs`, then render inside it.
 *
 * Waiting unclaimed matters. The job stays QUEUED, so nothing looks healthy
 * that is not rendering, and the web app's fallback still moves it if this
 * wait outlives LOCAL_RENDER_FALLBACK_SECONDS. If the lock is not ours in
 * time (someone is holding it, or a lock left by a dead worker that nobody can
 * vouch for), the job is handed to the cloud queue: never claimed, so no
 * attempt is spent, and its cloud message starts a fresh receive count. A
 * shutdown while waiting hands the message back to the local queue.
 *
 * A job this PC may not render (another workspace's, or a payload newer than this PC's build) goes to the cloud at
 * once, unclaimed, so it does not fail here and fail again on every retry.
 *
 * Before any of that, one read settles a message that is no longer worth
 * claiming (stale, a duplicate, or another worker's), without the lock: a
 * backlog of messages whose jobs already fell back to the cloud must not each
 * take the lock and its cooldown. A hold whose handler claimed nothing (the job
 * went stale while it waited) is released without a cooldown.
 */
export type LocalDeliveryDeps = {
  lock: HeavyLock;
  waitMs: number;
  /** How often the message's visibility is extended while waiting. */
  keepHiddenMs: number;
  visibilitySeconds: number;
  /** Moves the job to the cloud queue; false if it is no longer this queued local generation. */
  handOff: (message: RenderJobMessage) => Promise<boolean>;
  /**
   * One read of the job: settles (deletes or re-hides) a message that is no longer worth claiming and returns
   * its outcome, or null to go on. The handler's claim still decides; this only saves the lock.
   */
  settle?: (delivery: Delivery, message: RenderJobMessage) => Promise<Outcome | null>;
  /** Whether this PC may render the job (its workspace is one the PC's IAM user may write for). */
  allowed?: (message: RenderJobMessage) => Promise<boolean>;
  /**
   * Whether this PC's code can read the job's payload. False when the PC runs an older build than the web app (a new
   * title effect, say): the job goes to the cloud, which runs the deployed build, instead of failing here. Failing it
   * would fail every retry the same way, since a retry is routed to this PC again.
   */
  readable?: (message: RenderJobMessage) => Promise<boolean>;
  /** The normal handler: claims (calling `onClaimed`), renders, reports. */
  handle: (delivery: Delivery, onClaimed: () => void) => Promise<Outcome>;
  shutdown?: AbortSignal;
  log?: (message: string, error?: unknown) => void;
};

export async function handleLocalDelivery(deps: LocalDeliveryDeps, delivery: Delivery): Promise<Outcome> {
  const log = deps.log ?? ((message, error) => (error ? console.error(message, error) : console.log(message)));
  let message: RenderJobMessage;
  try {
    if (isAiStepMessage(delivery.body)) return deps.handle(delivery, () => undefined);
    message = parseRenderJobMessage(delivery.body);
  } catch {
    return deps.handle(delivery, () => undefined); // unparseable: the handler leaves it for the dead-letter queue
  }

  const settled = deps.settle ? await deps.settle(delivery, message) : null;
  if (settled) return settled;

  if (deps.allowed && !(await deps.allowed(message))) {
    const moved = await deps.handOff(message);
    log(`[${message.jobId}] not a workspace this PC renders for; ${moved ? "handed the job to the cloud queue" : "the job has moved on already"}`);
    await delivery.delete();
    return moved ? "handed-off" : "discarded";
  }

  if (deps.readable && !(await deps.readable(message))) {
    const moved = await deps.handOff(message);
    log(`[${message.jobId}] this PC's worker is older than the export (it cannot read the payload; update and restart it); ${moved ? "handed the job to the cloud queue" : "the job has moved on already"}`);
    await delivery.delete();
    return moved ? "handed-off" : "discarded";
  }

  const keepHidden = setInterval(() => {
    delivery.extend(deps.visibilitySeconds).catch((error) => log(`[${message.jobId}] could not extend visibility`, error));
  }, deps.keepHiddenMs);
  const waited = AbortSignal.timeout(deps.waitMs);
  let release: ReleaseHeavyLock;
  try {
    release = await deps.lock.acquire(`render ${message.jobId}`, deps.shutdown ? AbortSignal.any([deps.shutdown, waited]) : waited);
  } catch (error) {
    if (deps.shutdown?.aborted) {
      log(`[${message.jobId}] stopping while waiting for the heavy lock; handing the message back`);
      if (delivery.handBack) await delivery.handBack().catch(() => delivery.extend(0));
      else await delivery.extend(0);
      return "interrupted";
    }
    if (!waited.aborted) throw error;
    const moved = await deps.handOff(message);
    log(`[${message.jobId}] heavy lock not free after ${Math.round(deps.waitMs / 1000)}s; ${moved ? "handed the job to the cloud queue" : "the job has moved on already"}`);
    await delivery.delete();
    return moved ? "handed-off" : "discarded";
  } finally {
    clearInterval(keepHidden);
  }
  let claimed = false;
  try {
    return await deps.handle(delivery, () => { claimed = true; });
  } finally {
    // After the handler: its attempt scope has closed, so Chrome and ffmpeg are gone.
    await release({ idle: !claimed });
  }
}
