import { isEquirect, parseSongMap, spotSchema, transcriptSchema, type MediaKind, type SongMap, type Spot, type Transcript } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { mediaUrl } from "./storage";
import { faceHintFromChecks, type FaceHint } from "./face-hint";

/** A media asset as the editor sees it: what it is and where the browser can load it. */
export type LibraryAsset = {
  id: string;
  kind: MediaKind;
  fileName: string;
  /** Confirmed by a completed generation record, independent of filename. */
  isAiGenerated?: boolean;
  /** A generated take with the presenter in it (composed from her kit, or a script's take), not AI b-roll (ADR 0064). */
  isPresenterTake?: boolean;
  url: string;
  /** For an AI take: where the identity gate found the presenter's face on the composed first frame (ADR 0056/0057). */
  face?: FaceHint | null;
  thumbUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** A 360 photo (2:1 equirectangular image). */
  isPano: boolean;
  /** "Poly Haven, CC0 1.0" for imported library media; null for your own uploads. */
  credit: string | null;
  /** Set when the shot belongs to a home tour with a floor plan. */
  tourId: string | null;
  spot: Spot | null;
  room: string | null;
  /** For music: tempo and first beat, when detected. */
  bpm: number | null;
  beatOffsetMs: number | null;
  /** For music: where its bars start and its intro/build/drop/outro (ADR 0059), when analysed. */
  songMap: SongMap | null;
  /** A video whose light preview is still being made; url is the original until then. */
  previewPending: boolean;
  /**
   * Set for the workspace's private copy of an Instagram sound (ADR 0019):
   * edited against, never exported. Instagram plays it from its start.
   */
  instagram: { audioId: string; title: string; artist: string | null } | null;
  /** Speech with word timings, once the worker has transcribed a video (ADR 0035). */
  transcript: Transcript | null;
};

type LibraryAssetInput = {
  id: string;
  kind: MediaKind;
  fileName: string;
  objectKey: string;
  thumbKey: string | null;
  /** Set once a worker has made the 720p preview rendition. */
  previewKey?: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  license?: string | null;
  attribution?: string | null;
  tourId?: string | null;
  spot?: unknown;
  room?: string | null;
  bpm?: number | null;
  beatOffsetMs?: number | null;
  songMap?: unknown;
  instagramAudioId?: string | null;
  instagramTitle?: string | null;
  instagramArtist?: string | null;
  transcript?: unknown;
};

async function serializeLibraryAsset(asset: LibraryAssetInput, generation: { checks: unknown; presenter: boolean } | undefined): Promise<LibraryAsset> {
  const spot = spotSchema.safeParse(asset.spot);
  // The editor plays the light preview rendition when one exists; exports always use the original.
  const [url, thumbUrl] = await Promise.all([mediaUrl(asset.previewKey ?? asset.objectKey), asset.thumbKey ? mediaUrl(asset.thumbKey) : null]);
  const face = generation ? faceHintFromChecks(generation.checks) : null;
  return {
    id: asset.id,
    kind: asset.kind,
    fileName: asset.fileName,
    isAiGenerated: Boolean(generation),
    ...(generation?.presenter ? { isPresenterTake: true } : {}),
    url,
    ...(face ? { face } : {}),
    // A photo is its own thumbnail.
    thumbUrl: thumbUrl ?? (asset.kind === "IMAGE" ? url : null),
    durationMs: asset.durationMs,
    width: asset.width,
    height: asset.height,
    isPano: asset.kind === "IMAGE" && isEquirect(asset.width, asset.height),
    credit: asset.attribution ? [asset.attribution, asset.license].filter(Boolean).join(", ") : null,
    tourId: asset.tourId ?? null,
    spot: spot.success ? spot.data : null,
    room: asset.room ?? null,
    bpm: asset.bpm ?? null,
    beatOffsetMs: asset.beatOffsetMs ?? null,
    songMap: asset.kind === "AUDIO" ? parseSongMap(asset.songMap) : null,
    previewPending: asset.kind === "VIDEO" && asset.previewKey === null,
    instagram: asset.instagramAudioId
      ? { audioId: asset.instagramAudioId, title: asset.instagramTitle ?? asset.fileName, artist: asset.instagramArtist ?? null }
      : null,
    transcript: asset.transcript ? transcriptSchema.safeParse(asset.transcript).data ?? null : null,
  };
}

/** Whether a generation's shot put the presenter in it: composed with her kit or reference, or a script's take. */
function withPresenter(shot: unknown): boolean {
  if (!shot || typeof shot !== "object") return false;
  const { compose, script } = shot as { compose?: { presenterId?: unknown; presenter?: unknown } | null; script?: unknown };
  return Boolean(script || compose?.presenterId || compose?.presenter);
}

/** Resolve provenance once for a library page, without one database query per clip. */
export async function toLibraryAssets(assets: LibraryAssetInput[]): Promise<LibraryAsset[]> {
  const ids = assets.filter(asset => asset.kind === "VIDEO").map(asset => asset.id);
  const jobs = ids.length ? await prisma.aiGeneration.findMany({
    where: { status: "SUCCEEDED", assetId: { in: ids } }, select: { assetId: true, identityChecks: true, shot: true },
  }) : [];
  const generated = new Map(jobs.map(job => [job.assetId, { checks: job.identityChecks, presenter: withPresenter(job.shot) }]));
  return Promise.all(assets.map(asset => serializeLibraryAsset(asset, generated.get(asset.id))));
}

export async function toLibraryAsset(asset: LibraryAssetInput): Promise<LibraryAsset> {
  return (await toLibraryAssets([asset]))[0];
}
