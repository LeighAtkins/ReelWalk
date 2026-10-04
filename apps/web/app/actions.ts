"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MAX_UPLOAD_BYTES, resolveUploadType, SUPPORTED_UPLOAD_TYPES, uploadKeyFor } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { enqueueOrFail } from "@/lib/render-jobs";
import { headObject, presignUpload } from "@/lib/storage";
import { getCurrentUser } from "@/lib/workspace";

export type FormState = { error?: string };

const propertySchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  address: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
});

export async function createProperty(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = propertySchema.safeParse({
    title: formData.get("title") ?? "",
    address: formData.get("address") || undefined,
    description: formData.get("description") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const user = await getCurrentUser();
  const property = await prisma.property.create({ data: { ...parsed.data, workspaceId: user.workspaceId } });
  revalidatePath("/");
  redirect(`/properties/${property.id}`);
}

type UploadTicket = { ok: true; url: string; objectKey: string; contentType: string } | { ok: false; error: string };

/**
 * Step 1 of an upload. The file itself never passes through Next.js: the
 * browser PUTs it straight to S3 with the returned presigned URL.
 */
export async function createUploadUrl(input: {
  propertyId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): Promise<UploadTicket> {
  const user = await getCurrentUser();
  const property = await prisma.property.findFirst({ where: { id: input.propertyId, workspaceId: user.workspaceId } });
  if (!property) return { ok: false, error: "Property not found" };

  const resolved = resolveUploadType(input.contentType, input.fileName);
  if (!resolved) {
    return { ok: false, error: `Unsupported file type. Accepted: ${Object.values(SUPPORTED_UPLOAD_TYPES).join(", ")}` };
  }
  if (input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) return { ok: false, error: "File is empty or larger than 2 GB" };

  const objectKey = uploadKeyFor(property.id, randomUUID(), resolved.extension);
  return { ok: true, url: await presignUpload(objectKey, resolved.contentType), objectKey, contentType: resolved.contentType };
}

/** Step 2 of an upload: record the asset once the object really exists in S3. */
export async function confirmUpload(input: { propertyId: string; objectKey: string; fileName: string }): Promise<FormState> {
  const user = await getCurrentUser();
  const property = await prisma.property.findFirst({ where: { id: input.propertyId, workspaceId: user.workspaceId } });
  if (!property) return { error: "Property not found" };
  if (!input.objectKey.startsWith(`uploads/${property.id}/`)) return { error: "Upload does not belong to this property" };

  const head = await headObject(input.objectKey);
  if (!head) return { error: "Upload did not reach storage. Try again." };
  const resolved = resolveUploadType(head.contentType, input.objectKey);
  if (!resolved) return { error: "Unsupported file type" };

  await prisma.mediaAsset.upsert({
    where: { objectKey: input.objectKey },
    update: {},
    create: {
      propertyId: property.id,
      kind: resolved.kind,
      objectKey: input.objectKey,
      contentType: resolved.contentType,
      fileName: input.fileName.slice(0, 200),
      sizeBytes: head.sizeBytes,
    },
  });
  revalidatePath(`/properties/${property.id}`);
  return {};
}

const renderSchema = z.object({
  propertyId: z.string().min(1),
  mediaAssetId: z.string().min(1, "Choose a photo or video"),
  templateId: z.string().min(1, "Choose a template"),
  caption: z.string().trim().max(120).optional(),
});

export async function createRenderJob(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = renderSchema.safeParse({
    propertyId: formData.get("propertyId") ?? "",
    mediaAssetId: formData.get("mediaAssetId") ?? "",
    templateId: formData.get("templateId") ?? "",
    caption: formData.get("caption") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const user = await getCurrentUser();
  const [asset, template] = await Promise.all([
    prisma.mediaAsset.findFirst({
      where: { id: parsed.data.mediaAssetId, propertyId: parsed.data.propertyId, property: { workspaceId: user.workspaceId } },
    }),
    prisma.template.findUnique({ where: { id: parsed.data.templateId } }),
  ]);
  if (!asset) return { error: "Media not found for this property" };
  if (!template) return { error: "Template not found" };

  const job = await prisma.renderJob.create({
    data: {
      workspaceId: user.workspaceId,
      createdById: user.id,
      propertyId: asset.propertyId,
      mediaAssetId: asset.id,
      templateId: template.id,
      caption: parsed.data.caption ?? template.defaultCaption,
    },
  });
  const enqueued = await enqueueOrFail(job);

  revalidatePath(`/properties/${asset.propertyId}`);
  revalidatePath("/renders");
  return enqueued ? {} : { error: "Could not reach the render queue. The job was saved as failed; retry it below." };
}

export async function retryRenderJob(formData: FormData): Promise<void> {
  const jobId = String(formData.get("jobId") ?? "");
  const user = await getCurrentUser();

  // FAILED -> QUEUED as a single conditional write: two clicks (or two tabs)
  // can only ever produce one new generation and one new message.
  const retried = await prisma.renderJob.updateManyAndReturn({
    where: { id: jobId, workspaceId: user.workspaceId, status: "FAILED" },
    data: {
      status: "QUEUED",
      generation: { increment: 1 },
      attempt: 0,
      progress: 0,
      error: null,
      heartbeatAt: null,
      startedAt: null,
      finishedAt: null,
    },
  });
  const job = retried[0];
  if (job) await enqueueOrFail(job);

  if (job?.propertyId) revalidatePath(`/properties/${job.propertyId}`);
  revalidatePath("/renders");
}
