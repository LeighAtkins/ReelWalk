import { cameraKeyframeGenerateSchema, guidedKeyframeError, shotFramePairSchema, type CameraKeyframeInput, type ShotFramePair } from "@reelwalk/core";

export function framePairIntent(input: CameraKeyframeInput): string {
  const intent = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).parse(input);
  delete intent.guidedPair;
  return JSON.stringify(intent);
}
export function savedFramePairInput(pair: ShotFramePair): CameraKeyframeInput {
  shotFramePairSchema.parse(pair);
  const input = cameraKeyframeGenerateSchema.parse({ ...JSON.parse(pair.input), action: "generate", requestId: pair.startRequestId });
  const problem = guidedKeyframeError(input, pair.startRequestId);
  if (problem) throw Error(problem);
  if (input.role !== "start" || input.source.assetId !== pair.sourceAssetId || input.guidedPair?.id !== pair.id || input.guidedPair.endRequestId !== pair.endRequestId) throw Error("Saved frame preparation does not match this shot.");
  return cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).strip().parse(input);
}
export function framePairMatches(pair: ShotFramePair | undefined, input: CameraKeyframeInput | null): boolean {
  if (!pair || !input) return false;
  try {
    const revision = savedEndRevisionInput(pair);
    if (!revision) return framePairIntent(savedFramePairInput(pair)) === framePairIntent(input);
    const currentIntent = { ...revision, role: "start" as const };
    delete currentIntent.continuity;
    return framePairIntent(currentIntent) === framePairIntent(input);
  } catch { return false; }
}

/** Decode only an End whose frozen sources still belong to this retained pair. */
export function savedEndRevisionInput(pair: ShotFramePair): CameraKeyframeInput | null {
  savedFramePairInput(pair);
  if (!pair.endRevision) return null;
  const parsed = cameraKeyframeGenerateSchema.parse({ ...JSON.parse(pair.endRevision.input), action: "generate", requestId: pair.endRevision.requestId });
  if (parsed.role !== "end" || parsed.guidedPair || !parsed.cinematography || parsed.source.assetId !== pair.sourceAssetId || !pair.startAssetId || parsed.continuity?.assetId !== pair.startAssetId) throw Error("Saved End revision does not match this pair's original reference and retained Start.");
  return cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).strip().parse(parsed);
}

export function activeEndRequestId(pair: ShotFramePair): string {
  return savedEndRevisionInput(pair) ? pair.endRevision!.requestId : pair.endRequestId;
}

/** One explicit End-only decision creates one new request; original pair identities stay frozen. */
export function newEndRevision(pair: ShotFramePair, currentStartIntent: CameraKeyframeInput, retainedStartAssetId: string, uuid = () => crypto.randomUUID(), now = new Date()): ShotFramePair {
  savedEndRevisionInput(pair);
  const current = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).parse(currentStartIntent);
  if (current.role !== "start" || current.continuity || current.source.assetId !== pair.sourceAssetId || !current.cinematography || !pair.startAssetId || pair.startAssetId !== retainedStartAssetId) throw Error("Keep this pair's original reference and retained Start when adjusting End.");
  const requestId = uuid();
  if (requestId === pair.endRevision?.requestId) throw Error("Use a new request identity for a new End revision.");
  const end: CameraKeyframeInput = { ...current, role: "end", continuity: { assetId: retainedStartAssetId, atMs: 0 } };
  delete end.guidedPair;
  const previousJobId = pair.endRevision?.jobId ?? pair.endJobId;
  const revised = shotFramePairSchema.parse({ ...pair, endRevision: { requestId, input: JSON.stringify(end), requestedAt: now.toISOString(), ...(previousJobId ? { previousJobId } : {}) } });
  savedEndRevisionInput(revised);
  return revised;
}
export function newFramePair(input: CameraKeyframeInput, uuid = () => crypto.randomUUID(), now = new Date()): ShotFramePair {
  const id = uuid(), startRequestId = uuid(), endRequestId = uuid();
  const frozen = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).parse({ ...input, role: "start", guidedPair: { version: 1, id, endRequestId } });
  const pair = shotFramePairSchema.parse({ version: 1, id, sourceAssetId: frozen.source.assetId, startRequestId, endRequestId, input: JSON.stringify(frozen), requestedAt: now.toISOString() });
  savedFramePairInput(pair);
  return pair;
}
