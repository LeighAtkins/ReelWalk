import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = process.env.S3_BUCKET ?? "reelwalk-dev";
const cloudfrontBaseUrl = process.env.CLOUDFRONT_BASE_URL ?? "";

function makeClient(endpoint: string | undefined): S3Client {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  return new S3Client({
    region: process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    endpoint: endpoint || undefined,
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true").toLowerCase() === "true",
    // Without explicit keys the SDK uses its default chain (IRSA on EKS).
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    // Presigned browser uploads cannot send the SDK's optional checksum headers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

// Server-side calls go to the in-cluster endpoint. Presigned URLs are opened
// by the browser, so they must be signed for the address the browser can reach.
const s3 = makeClient(process.env.S3_ENDPOINT_URL);
const presignClient = makeClient(process.env.S3_PUBLIC_ENDPOINT_URL || process.env.S3_ENDPOINT_URL);

export async function presignUpload(objectKey: string, contentType: string): Promise<string> {
  return getSignedUrl(presignClient, new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType }), {
    expiresIn: 600,
  });
}

/** Size of each part of a multipart upload (S3 needs at least 5 MB). */
export const UPLOAD_PART_BYTES = 16 * 1024 * 1024;

/**
 * A big file goes up in parts, so a dropped connection costs one part, not
 * the whole file. Part URLs stay valid for six hours: a phone on a slow
 * network can take that long over 2 GB, and each part is signed up front.
 */
export async function startMultipartUpload(objectKey: string, contentType: string, sizeBytes: number): Promise<{ uploadId: string; partUrls: string[] }> {
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType }));
  if (!UploadId) throw new Error("Storage did not start the upload.");
  const parts = Math.max(1, Math.ceil(sizeBytes / UPLOAD_PART_BYTES));
  const partUrls = await Promise.all(
    Array.from({ length: parts }, (_, index) =>
      getSignedUrl(presignClient, new UploadPartCommand({ Bucket: bucket, Key: objectKey, UploadId, PartNumber: index + 1 }), {
        expiresIn: 6 * 3600,
      }),
    ),
  );
  return { uploadId: UploadId, partUrls };
}

export async function completeMultipartUpload(objectKey: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: objectKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    }),
  );
}

export async function abortMultipartUpload(objectKey: string, uploadId: string): Promise<void> {
  await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId }));
}

/** Deletes objects in batches of 1000 (the most one request takes). Keys that do not exist are fine. */
export async function deleteObjects(objectKeys: string[]): Promise<void> {
  for (let start = 0; start < objectKeys.length; start += 1000) {
    const batch = objectKeys.slice(start, start + 1000);
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
  }
}

/** Server-side write, for files the app fetches itself (stock imports). Browser uploads use presigned URLs instead. */
export async function putObject(objectKey: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body, ContentType: contentType }));
}

export async function headObject(objectKey: string): Promise<{ sizeBytes: number; contentType: string } | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType ?? "application/octet-stream" };
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) return null;
    throw error;
  }
}

const SIGNED_URL_TTL_SECONDS = 3600;

// Signing the same key twice gives two different URLs, because the timestamp
// is part of the signature, and a changed src makes the browser reload the
// image or restart the video. Pages re-render every 2s while a job is active,
// so a signed URL is reused for the first half of its lifetime.
const signedUrls = new Map<string, { url: string; reuseUntil: number }>();

/** URL the browser can play or download. CloudFront when configured, otherwise a presigned GET. */
/** An object's bytes, for the server to look at (a shot's still for room labelling). Null when it is missing or too big. */
export async function readObject(objectKey: string, maxBytes = 6 * 1024 * 1024): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (!object.Body || (object.ContentLength ?? 0) > maxBytes) return null;
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    return { bytes, contentType: object.ContentType ?? "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * A presigned S3 GET that expires in `expiresIn` seconds, never the CDN:
 * for a file that should be readable briefly by the signed-in studio only
 * (Inspect's original, ADR 0057), not cached at the edge or kept forever.
 */
export async function presignedObjectUrl(objectKey: string, expiresIn = 900): Promise<string> {
  return getSignedUrl(presignClient, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { expiresIn });
}

export async function mediaUrl(objectKey: string, options: { downloadAs?: string } = {}): Promise<string> {
  if (/^https?:\/\//.test(cloudfrontBaseUrl) && !options.downloadAs) {
    return `${cloudfrontBaseUrl.replace(/\/$/, "")}/${objectKey}`;
  }

  const cacheKey = `${objectKey}\n${options.downloadAs ?? ""}`;
  const cached = signedUrls.get(cacheKey);
  if (cached && cached.reuseUntil > Date.now()) return cached.url;

  const url = await getSignedUrl(
    presignClient,
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ResponseContentDisposition: options.downloadAs ? `attachment; filename="${options.downloadAs}"` : undefined,
    }),
    { expiresIn: SIGNED_URL_TTL_SECONDS },
  );
  // Crude bound: dropping everything only costs one re-sign per key.
  if (signedUrls.size >= 5000) signedUrls.clear();
  signedUrls.set(cacheKey, { url, reuseUntil: Date.now() + (SIGNED_URL_TTL_SECONDS * 1000) / 2 });
  return url;
}

/**
 * An object streamed to a local file (a render for the verification routes,
 * ADR 0071): never held in memory, so a long export costs disk, not heap.
 */
export async function downloadObject(objectKey: string, destination: string): Promise<void> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!object.Body) throw new Error(`Storage returned no body for ${objectKey}`);
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  await pipeline(Readable.fromWeb(object.Body.transformToWebStream() as import("node:stream/web").ReadableStream), createWriteStream(destination));
}
