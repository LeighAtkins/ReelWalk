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
  try { return framePairIntent(savedFramePairInput(pair)) === framePairIntent(input); } catch { return false; }
}
export function newFramePair(input: CameraKeyframeInput, uuid = () => crypto.randomUUID(), now = new Date()): ShotFramePair {
  const id = uuid(), startRequestId = uuid(), endRequestId = uuid();
  const frozen = cameraKeyframeGenerateSchema.omit({ action: true, requestId: true }).parse({ ...input, role: "start", guidedPair: { version: 1, id, endRequestId } });
  const pair = shotFramePairSchema.parse({ version: 1, id, sourceAssetId: frozen.source.assetId, startRequestId, endRequestId, input: JSON.stringify(frozen), requestedAt: now.toISOString() });
  savedFramePairInput(pair);
  return pair;
}
