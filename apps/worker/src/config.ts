export type WorkerConfig = {
  sqsEndpointUrl?: string;
  queueUrl: string;
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
  /** How often the worker looks for outbox messages the web app could not send itself. */
  outboxPollSeconds: number;
  /** Browser tabs per render. */
  renderConcurrency: number;
  healthPort: number;
};

function valueOrUndefined(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key] || undefined;
}

function numberFrom(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key]);
  return env[key] && Number.isFinite(value) ? value : fallback;
}

export function getConfig(env = process.env): WorkerConfig {
  const config: WorkerConfig = {
    sqsEndpointUrl: valueOrUndefined(env, "SQS_ENDPOINT_URL"),
    queueUrl: env.SQS_QUEUE_URL ?? "http://localhost:9324/000000000000/render-jobs",
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
    outboxPollSeconds: numberFrom(env, "OUTBOX_POLL_SECONDS", 5),
    renderConcurrency: numberFrom(env, "RENDER_CONCURRENCY", 4),
    healthPort: numberFrom(env, "HEALTH_PORT", 8081),
  };

  // A crashed worker's message reappears after `visibilitySeconds`. By then
  // its heartbeat must already look stale, or the redelivery would be deferred
  // and burn one of the job's attempts for nothing.
  if (config.staleSeconds >= config.visibilitySeconds || config.heartbeatSeconds >= config.staleSeconds) {
    throw new Error("Expected RENDER_HEARTBEAT_SECONDS < RENDER_STALE_SECONDS < RENDER_VISIBILITY_SECONDS");
  }
  return config;
}
