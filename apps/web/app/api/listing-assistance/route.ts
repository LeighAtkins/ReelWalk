import { z } from "zod";
import { canDirectAiVideo } from "@reelwalk/core";
import { getSessionUser } from "@/lib/auth";
import { startAiJob } from "@/lib/ai-jobs";
import { parseListing, suggestShot } from "@/lib/listing-assistance";
import { createAiGeneration } from "@/lib/ai-video";
import { ensureWorkerRunning } from "@/lib/render-capacity";
export const maxDuration = 120;
const inputSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("listing"), text: z.string().trim().min(10).max(12000) }), z.object({ kind: z.literal("video-suggestion"), assetId: z.string().min(1).max(64), requestId: z.string().uuid() })]);
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, message: "Sign in again." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ ok: false, message: "Invalid origin." }, { status: 403 });
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, message: "Choose a photo or paste listing text." }, { status: 400 });
  const input = parsed.data;
  const jobId = await startAiJob({ workspaceId: user.workspaceId, kind: input.kind }, async () => {
    if (input.kind === "listing") return { ok: true, fields: await parseListing(user, input.text) };
    const suggestion = await suggestShot(user, input.assetId);
    // Re-read standing consent in createAiGeneration before any debit. Trial/guest users never auto-spend.
    if (suggestion.recommended && canDirectAiVideo(user.workspace)) {
      const job = await createAiGeneration(user, { requestId: input.requestId, prompt: suggestion.prompt, durationSeconds: suggestion.durationSeconds, referenceAssetId: input.assetId, consent: false, execution: "director" });
      await ensureWorkerRunning().catch(() => undefined);
      return { ok: true, suggestion, generatedJobId: job.id };
    }
    return { ok: true, suggestion };
  });
  return Response.json({ ok: true, jobId });
}
