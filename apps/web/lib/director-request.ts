import { createHash } from "node:crypto";

/** Stable identity across approval retries, distinct for every Opus proposal. */
export function directorGenerationRequestId(editId: string, index: number) {
  const b = createHash("sha256").update(`opus-director:${editId}:${index}`).digest().subarray(0, 16);
  b[6] = (b[6] & 15) | 80; b[8] = (b[8] & 63) | 128;
  const s = b.toString("hex"); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
