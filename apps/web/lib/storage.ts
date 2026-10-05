import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

export async function headObject(objectKey: string): Promise<{ sizeBytes: number; contentType: string } | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType ?? "application/octet-stream" };
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) return null;
    throw error;
  }
}

/** URL the browser can play or download. CloudFront when configured, otherwise a presigned GET. */
export async function mediaUrl(objectKey: string, options: { downloadAs?: string } = {}): Promise<string> {
  if (/^https?:\/\//.test(cloudfrontBaseUrl) && !options.downloadAs) {
    return `${cloudfrontBaseUrl.replace(/\/$/, "")}/${objectKey}`;
  }
  return getSignedUrl(
    presignClient,
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ResponseContentDisposition: options.downloadAs ? `attachment; filename="${options.downloadAs}"` : undefined,
    }),
    { expiresIn: 3600 },
  );
}
