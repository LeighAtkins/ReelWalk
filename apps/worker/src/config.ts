export type WorkerConfig = {
  /**
   * "cloud": the normal worker. "local" (ADR 0094): a worker on the owner's PC
   * that only renders what arrives on its queue (the local render queue): no
   * AI video polling, no AI step reaper, and it relays only local messages.
   */
  mode: "cloud" | "local";
  sqsEndpointUrl?: string;
  /** The queue this worker consumes (in local mode, the local render queue). */
  queueUrl: string;
  /** A cloud worker's outbox relay sends local render messages here (ADR 0094); unset sends them to queueUrl. */
  localQueueUrl?: string;
  /**
   * A machine-wide lock directory taken around each render (mkdir + owner.txt,
   * never stolen), so a local worker shares the PC with other heavy jobs.
   */
  heavyLockDir?: string;
  heavyLockOwner: string;
  deadLetterQueueUrl?: string;
  awsRegion: string;
  s3EndpointUrl?: string;
  s3Region: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3Bucket: string;
  s3ForcePathStyle: boolean;
  /** Must equal the queue's redrive maxReceiveCount. */
  maxAttempts: number;
  /** How long a received message stays hidden; extended by the heartbeat while rendering. */
  visibilitySeconds: number;
  heartbeatSeconds: number;
  /** A RUNNING job with no heartbeat for this long is assumed to have lost its worker. */
  staleSeconds: number;
  retryBackoffSeconds: number;
  /** The most one render attempt may take before it is failed and retried. */
  jobTimeoutSeconds: number;
  /**
   * How long a stopped render attempt (deadline, SIGTERM) may take to unwind,
   * and then how long releasing Chrome, ffmpeg and temp files may take: a
   * stopped attempt is reported within twice this.
   */
  abortGraceSeconds: number;
  /**
   * After SIGTERM, how long the current render may keep going before it is
   * stopped and handed back. 0 on ECS (the task is killed 30 s after the
   * signal); on Kubernetes, with a long termination grace, set it so a render
   * can finish during a rollout.
   */
  shutdownDrainSeconds: number;
  /** How long the platform waits after SIGTERM before SIGKILL: ECS stopTimeout, or terminationGracePeriodSeconds. */
  stopTimeoutSeconds: number;
  /** How often the worker looks for outbox messages the web app could not send itself. */
  outboxPollSeconds: number;
  /** Browser tabs per render. */
  renderConcurrency: number;
  healthPort: number;
  /**
   * Exit after this long without a message. 0 keeps the worker running
   * forever (Kubernetes, Compose). An on-demand task (ECS run by the web app
   * when an export is queued) sets it so the task stops costing money.
   */
  idleExitSeconds: number;
};

function valueOrUndefined(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key] || undefined;
}

function numberFrom(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key]);
  return env[key] && Number.isFinite(value) ? value : fallback;
}

/** Time left after the grace for the hand-back's database write and SQS calls. */
const SHUTDOWN_REPORT_SECONDS = 5;

export function getConfig(env = process.env): WorkerConfig {
  const config: WorkerConfig = {
    mode: env.WORKER_MODE === "local" ? "local" : "cloud",
    sqsEndpointUrl: valueOrUndefined(env, "SQS_ENDPOINT_URL"),
    queueUrl: env.SQS_QUEUE_URL ?? "http://localhost:9324/000000000000/render-jobs",
    localQueueUrl: valueOrUndefined(env, "LOCAL_RENDER_QUEUE_URL"),
    heavyLockDir: valueOrUndefined(env, "HEAVY_LOCK_DIR"),
    heavyLockOwner: env.HEAVY_LOCK_OWNER || "reelwalk-local-worker",
    deadLetterQueueUrl: valueOrUndefined(env, "SQS_DLQ_URL"),
    awsRegion: env.AWS_REGION ?? env.S3_REGION ?? "us-east-1",
    s3EndpointUrl: valueOrUndefined(env, "S3_ENDPOINT_URL"),
    s3Region: env.S3_REGION ?? env.AWS_REGION ?? "us-east-1",
    s3AccessKeyId: valueOrUndefined(env, "S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: valueOrUndefined(env, "S3_SECRET_ACCESS_KEY"),
    s3Bucket: env.S3_BUCKET ?? "reelwalk-dev",
    s3ForcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true").toLowerCase() === "true",
    maxAttempts: numberFrom(env, "RENDER_MAX_ATTEMPTS", 3),
    visibilitySeconds: numberFrom(env, "RENDER_VISIBILITY_SECONDS", 120),
    heartbeatSeconds: numberFrom(env, "RENDER_HEARTBEAT_SECONDS", 20),
    staleSeconds: numberFrom(env, "RENDER_STALE_SECONDS", 60),
    retryBackoffSeconds: numberFrom(env, "RENDER_RETRY_BACKOFF_SECONDS", 15),
    jobTimeoutSeconds: numberFrom(env, "RENDER_JOB_TIMEOUT_SECONDS", 45 * 60),
    abortGraceSeconds: numberFrom(env, "RENDER_ABORT_GRACE_SECONDS", 10),
    shutdownDrainSeconds: numberFrom(env, "RENDER_SHUTDOWN_DRAIN_SECONDS", 0),
    stopTimeoutSeconds: numberFrom(env, "RENDER_STOP_TIMEOUT_SECONDS", 30),
    outboxPollSeconds: numberFrom(env, "OUTBOX_POLL_SECONDS", 5),
    renderConcurrency: numberFrom(env, "RENDER_CONCURRENCY", 4),
    healthPort: numberFrom(env, "HEALTH_PORT", 8081),
    idleExitSeconds: numberFrom(env, "WORKER_IDLE_EXIT_SECONDS", 0),
  };

  // A crashed worker's message reappears after `visibilitySeconds`. By then
  // its heartbeat must already look stale, or the redelivery would be deferred
  // and burn one of the job's attempts for nothing.
  if (config.staleSeconds >= config.visibilitySeconds || config.heartbeatSeconds >= config.staleSeconds) {
    throw new Error("Expected RENDER_HEARTBEAT_SECONDS < RENDER_STALE_SECONDS < RENDER_VISIBILITY_SECONDS");
  }
  // After SIGTERM the render may drain, then gets one grace to unwind and one to release, and the hand-back
  // still has to reach the database and SQS before the platform's SIGKILL (ADR 0050).
  if (config.shutdownDrainSeconds + 2 * config.abortGraceSeconds + SHUTDOWN_REPORT_SECONDS > config.stopTimeoutSeconds) {
    throw new Error(
      `Expected RENDER_SHUTDOWN_DRAIN_SECONDS + 2 x RENDER_ABORT_GRACE_SECONDS + ${SHUTDOWN_REPORT_SECONDS} <= RENDER_STOP_TIMEOUT_SECONDS (${config.shutdownDrainSeconds} + 2 x ${config.abortGraceSeconds} + ${SHUTDOWN_REPORT_SECONDS} > ${config.stopTimeoutSeconds})`,
    );
  }
  return config;
}
