import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Redis from "ioredis";
import pg from "pg";
import { getConfig } from "./config";
import { outputKeyFor, parseRenderJobPayload, RenderJobPayload } from "./job";

const { Pool } = pg;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function downloadObject(client: S3Client, bucket: string, key: string, destination: string) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`No body returned for ${key}`);
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(destination));
}

async function uploadObject(client: S3Client, bucket: string, key: string, source: string) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: await readFile(source),
      ContentType: "video/mp4",
    }),
  );
}

async function markJob(pool: pg.Pool, jobId: string, status: string, outputKey?: string, error?: string) {
  await pool.query(
    `
    update render_jobs
    set status = $1,
        output_key = coalesce($2, output_key),
        error = $3,
        updated_at = now()
    where id = $4
    `,
    [status, outputKey ?? null, error ?? null, jobId],
  );
}

async function processEditorJob(
  job: RenderJobPayload,
  pool: pg.Pool,
  s3: S3Client,
  config = getConfig()
) {
  const workdir = await mkdir(path.join(os.tmpdir(), `reelwalk-editor-${job.jobId}`), {
    recursive: true,
  }).then(() => path.join(os.tmpdir(), `reelwalk-editor-${job.jobId}`));

  const projectPath = path.join(workdir, "project.json");
  const outputPath = path.join(workdir, "output.mp4");
  const outputKey = outputKeyFor(job);

  try {
    console.log(`[editor-render:${job.jobId}] mark running`);
    await markJob(pool, job.jobId, "running");

    // inputKey contains the project JSON for editor renders
    const projectJson = job.inputKey;
    await writeFile(projectPath, projectJson, "utf-8");
    console.log(`[editor-render:${job.jobId}] wrote project.json (${projectJson.length} bytes)`);

    console.log(`[editor-render:${job.jobId}] starting render...`);
    await run(
      "pnpm",
        [
          "--filter",
          "@reelwalk/render",
          "exec",
          "tsx",
          "src/render-timeline.ts",
          "--project",
          projectPath,
          "--output",
          outputPath,
        ],
        config.workspaceDir,
    );

    const outputStats = await stat(outputPath);
    console.log(`[editor-render:${job.jobId}] rendered ${outputStats.size} bytes`);

    console.log(`[editor-render:${job.jobId}] upload s3://${config.s3Bucket}/${outputKey}`);
    await uploadObject(s3, config.s3Bucket, outputKey, outputPath);

    console.log(`[editor-render:${job.jobId}] mark done`);
    await markJob(pool, job.jobId, "done", outputKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[editor-render:${job.jobId}] failed`, error);
    await markJob(pool, job.jobId, "failed", undefined, message);
  } finally {
    console.log(`[editor-render:${job.jobId}] cleanup ${workdir}`);
    await rm(workdir, { recursive: true, force: true });
  }
}

async function processLegacyJob(
  job: RenderJobPayload,
  pool: pg.Pool,
  s3: S3Client,
  config = getConfig()
) {
  const workdir = await mkdir(path.join(os.tmpdir(), `reelwalk-${job.jobId}`), {
    recursive: true,
  }).then(() => path.join(os.tmpdir(), `reelwalk-${job.jobId}`));

  const inputPath = path.join(workdir, "input.mp4");
  const outputPath = path.join(workdir, "stub.mp4");
  const outputKey = outputKeyFor(job);

  try {
    console.log(`[render:${job.jobId}] mark running`);
    await markJob(pool, job.jobId, "running");
    console.log(`[render:${job.jobId}] download s3://${config.s3Bucket}/${job.inputKey}`);
    await downloadObject(s3, config.s3Bucket, job.inputKey, inputPath);
    const inputStats = await stat(inputPath);
    console.log(`[render:${job.jobId}] downloaded ${inputStats.size} bytes to ${inputPath}`);
    console.log(`[render:${job.jobId}] start render ${outputPath}`);
    await run(
      "pnpm",
      [
        "--filter",
        "@reelwalk/render",
        "exec",
        "tsx",
        "src/render-job.ts",
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--caption",
        "Task 01 stub render",
        "--brand",
        "ReelWalk",
      ],
      config.workspaceDir,
    );
    const outputStats = await stat(outputPath);
    console.log(`[render:${job.jobId}] rendered ${outputStats.size} bytes`);
    console.log(`[render:${job.jobId}] upload s3://${config.s3Bucket}/${outputKey}`);
    await uploadObject(s3, config.s3Bucket, outputKey, outputPath);
    console.log(`[render:${job.jobId}] mark done`);
    await markJob(pool, job.jobId, "done", outputKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[render:${job.jobId}] failed`, error);
    await markJob(pool, job.jobId, "failed", undefined, message);
  } finally {
    console.log(`[render:${job.jobId}] cleanup ${workdir}`);
    await rm(workdir, { recursive: true, force: true });
  }
}

async function processJob(
  job: RenderJobPayload,
  pool: pg.Pool,
  s3: S3Client,
  config = getConfig()
) {
  if (job.type === "editor") {
    return processEditorJob(job, pool, s3, config);
  }
  return processLegacyJob(job, pool, s3, config);
}

async function main() {
  const config = getConfig();
  const redis = new Redis(config.redisUrl);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const credentials =
    config.s3AccessKeyId && config.s3SecretAccessKey
      ? {
          accessKeyId: config.s3AccessKeyId,
          secretAccessKey: config.s3SecretAccessKey,
        }
      : undefined;
  const s3 = new S3Client({
    endpoint: config.s3EndpointUrl,
    region: config.s3Region,
    credentials,
    forcePathStyle: config.s3ForcePathStyle,
  });

  console.log(`Worker polling ${config.queueName}`);
  while (true) {
    const raw = await redis.lpop(config.queueName);
    if (!raw) {
      await wait(config.pollSeconds * 1000);
      continue;
    }
    const job = parseRenderJobPayload(raw);
    console.log(`Rendering job ${job.jobId} (type: ${job.type ?? "legacy"})`);
    await processJob(job, pool, s3, config);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
