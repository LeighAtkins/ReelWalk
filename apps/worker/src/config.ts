export type WorkerConfig = {
  databaseUrl: string;
  redisUrl: string;
  queueName: string;
  s3EndpointUrl?: string;
  s3Region: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3Bucket: string;
  s3ForcePathStyle: boolean;
  workspaceDir: string;
  renderPackageDir: string;
  pollSeconds: number;
};

function valueOrDefault(env: NodeJS.ProcessEnv, key: string, defaultValue: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, key)) return env[key] || undefined;
  return defaultValue;
}

function valueOrUndefined(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key] || undefined;
}

export function getConfig(env = process.env): WorkerConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgresql://reelwalk:reelwalk@localhost:5432/reelwalk",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379/0",
    queueName: env.RENDER_QUEUE_NAME ?? "render_jobs",
    s3EndpointUrl: valueOrDefault(env, "S3_ENDPOINT_URL", "http://localhost:9000"),
    s3Region: env.S3_REGION ?? env.AWS_REGION ?? "us-east-1",
    s3AccessKeyId: valueOrUndefined(env, "S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: valueOrUndefined(env, "S3_SECRET_ACCESS_KEY"),
    s3Bucket: env.S3_BUCKET ?? "reelwalk-dev",
    s3ForcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true").toLowerCase() === "true",
    workspaceDir: env.WORKSPACE_DIR ?? process.cwd(),
    renderPackageDir: env.RENDER_PACKAGE_DIR ?? `${process.cwd()}/packages/render`,
    pollSeconds: Number(env.WORKER_POLL_SECONDS ?? "2"),
  };
}
