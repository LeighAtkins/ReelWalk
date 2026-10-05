import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { inputFilenameFor, outputKeyFor } from "@reelwalk/core";
import { renderStubReel } from "@reelwalk/render/render-job";
import { renderTimelineProject } from "@reelwalk/render/render-timeline";
import type { ClaimedJob, RenderResult } from "./handler";

async function downloadObject(client: S3Client, bucket: string, key: string, destination: string) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`No body returned for ${key}`);
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(destination));
}

/**
 * Renders one job to MP4 and uploads it. The output key is derived from the
 * job id, so running this twice for the same job overwrites one object.
 */
export async function renderJob(
  job: ClaimedJob,
  s3: S3Client,
  bucket: string,
  onProgress: (percent: number) => void,
): Promise<RenderResult> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), `reelwalk-${job.id}-`));
  const outputPath = path.join(workdir, "output.mp4");
  const report = (fraction: number) => onProgress(Math.min(100, Math.round(fraction * 100)));

  try {
    if (job.kind === "EDITOR") {
      const projectPath = path.join(workdir, "project.json");
      await writeFile(projectPath, JSON.stringify(job.payload), "utf-8");
      await renderTimelineProject({ project: projectPath, output: outputPath }, report);
    } else {
      if (!job.inputKey) throw new Error("The source media for this render was deleted");
      const inputPath = path.join(workdir, inputFilenameFor(job.inputKey));
      console.log(`[${job.id}] download s3://${bucket}/${job.inputKey}`);
      await downloadObject(s3, bucket, job.inputKey, inputPath);
      await renderStubReel(
        { input: inputPath, output: outputPath, caption: job.caption ?? undefined, brand: job.brand ?? undefined },
        report,
      );
    }

    const objectKey = outputKeyFor(job.id);
    const { size } = await stat(outputPath);
    console.log(`[${job.id}] upload ${size} bytes to s3://${bucket}/${objectKey}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: createReadStream(outputPath),
        ContentLength: size,
        ContentType: "video/mp4",
      }),
    );
    return { objectKey, contentType: "video/mp4", sizeBytes: size };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
