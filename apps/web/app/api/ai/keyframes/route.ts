import { z } from "zod";
import { cameraKeyframeGenerateSchema } from "@reelwalk/core";
import { AiCreditError, KeyframeError } from "@reelwalk/db";
import { getSessionUser } from "@/lib/auth";
import { generateKeyframe, keyframeArtifact, listKeyframes, useKeyframe } from "@/lib/ai-keyframes";
import { ensureWorkerRunning } from "@/lib/render-capacity";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
const useSchema = z.object({ action: z.literal("use"), jobId: z.string().min(1).max(128) }).strict();
function failure(error: unknown) {
  const status = error instanceof KeyframeError ? error.status : error instanceof AiCreditError || error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
  return Response.json({ error: error instanceof KeyframeError || error instanceof AiCreditError ? error.message : "Image operation unavailable. Refresh to check the existing request before trying again." }, { status, headers });
}
export async function GET(request: Request) {
  const actor = await getSessionUser(); if (!actor) return Response.json({ error: "Sign in." }, { status: 401, headers });
  try {
    const query = new URL(request.url).searchParams;
    if (query.has("artifact")) {
      const artifact = z.enum(["source", "continuity", "candidate"]).parse(query.get("artifact"));
      const id = z.string().min(1).max(128).parse(query.get("job"));
      const result = await keyframeArtifact(actor, id, artifact);
      return new Response(new Uint8Array(result.bytes), { headers: { ...headers, "Content-Type": result.contentType, "X-Content-Type-Options": "nosniff" } });
    }
    const result = await listKeyframes(actor);
    // UNKNOWN is not standing capacity demand. Only an explicit recovery action wakes a receipt-only pass.
    if (result.jobs.some(job => job.status === "QUEUED" || job.status === "SUBMITTING" || query.get("recover") === "1" && job.status === "UNKNOWN")) await ensureWorkerRunning();
    return Response.json(result, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const actor = await getSessionUser(); if (!actor) return Response.json({ error: "Sign in." }, { status: 401, headers });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
  try {
    const reader = request.body?.getReader(); if (!reader) throw new KeyframeError("Missing body", 400);
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 16000) { await reader.cancel(); throw new KeyframeError("Body too large", 400); } chunks.push(part.value); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value.action === "use") return Response.json(await useKeyframe(actor, useSchema.parse(value).jobId), { headers });
    const job = await generateKeyframe(actor, cameraKeyframeGenerateSchema.parse(value));
    await ensureWorkerRunning();
    return Response.json({ job }, { status: 202, headers });
  } catch (error) { return failure(error); }
}
