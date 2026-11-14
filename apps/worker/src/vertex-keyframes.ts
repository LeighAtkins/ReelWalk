import { CAMERA_KEYFRAME_MODEL } from "@reelwalk/core";
import { vertexAuth, type AwsCredentials } from "./vertex-video";

export type KeyframeReceipt = { version: 1; status: number; incomplete: boolean; bodyBase64: string };
/** Token refresh precedes the dispatch claim. Exactly one fetch; no model/project fallback. */
export async function keyframeTransport(credentials?: AwsCredentials) {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project || process.env.AI_KEYFRAMES_ENABLED !== "true") throw new Error("Image generation is disabled.");
  const token = await vertexAuth(credentials)();
  if (!token) throw new Error("Google image credentials unavailable.");
  return {
    async submit(body: string): Promise<KeyframeReceipt> {
      const response = await fetch(`https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/publishers/google/models/${CAMERA_KEYFRAME_MODEL}:generateContent`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
        signal: AbortSignal.timeout(120_000),
      });
      const chunks: Buffer[] = []; let size = 0; let incomplete = !response.body;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            const remaining = 24 * 1024 * 1024 - size;
            chunks.push(Buffer.from(part.value.subarray(0, remaining))); size += Math.min(remaining, part.value.length);
            if (part.value.length > remaining) { incomplete = true; await reader.cancel().catch(() => {}); break; }
          }
        } catch { incomplete = true; }
      }
      return { version: 1, status: response.status, incomplete, bodyBase64: Buffer.concat(chunks).toString("base64") };
    },
  };
}
