import { createHash } from "node:crypto";

/** A UUID derived from a stable key, so the same approval retried reuses its credit reservation. */
function stableUuid(key: string) {
  const b = createHash("sha256").update(key).digest().subarray(0, 16);
  b[6] = (b[6] & 15) | 80; b[8] = (b[8] & 63) | 128;
  const s = b.toString("hex"); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

/** Stable identity across approval retries, distinct for every Opus proposal. */
export function directorGenerationRequestId(editId: string, index: number) {
  return stableUuid(`opus-director:${editId}:${index}`);
}

/** Stable identity for each take of a script (ADR 0060), within the studio's workspace. */
export function scriptGenerationRequestId(workspaceId: string, key: string) {
  return stableUuid(`presenter-script:${workspaceId}:${key}`);
}
