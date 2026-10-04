import { z } from "zod";
import { prisma } from "@reelwalk/db";
import { enqueueOrFail } from "@/lib/render-jobs";
import { getCurrentUser } from "@/lib/workspace";

// Called by the standalone timeline editor, not by this app's own UI, so it
// is a Route Handler with a stable JSON contract rather than a Server Action.
const projectSchema = z.object({
  id: z.string(),
  name: z.string().default("Untitled"),
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  fps: z.number().int().positive().default(30),
  tracks: z.array(z.unknown()).default([]),
});

export async function POST(request: Request) {
  const parsed = projectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ detail: "Invalid editor project" }, { status: 400 });

  const user = await getCurrentUser();
  const job = await prisma.renderJob.create({
    data: {
      workspaceId: user.workspaceId,
      createdById: user.id,
      kind: "EDITOR",
      payload: parsed.data as object,
      caption: parsed.data.name,
    },
  });
  const enqueued = await enqueueOrFail(job);

  return Response.json({ job_id: job.id, status: enqueued ? "queued" : "failed" }, { status: enqueued ? 200 : 503 });
}
