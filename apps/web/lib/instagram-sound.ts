import {
  FAKE_INSTAGRAM_AUDIO,
  fakeInstagramSoundWav,
  INSTAGRAM_PREVIEW_MAX_BYTES,
  instagramPreviewFormat,
  instagramPreviewKeyFor,
  type InstagramAudioType,
} from "@reelwalk/core";
import { prisma, type MediaAsset } from "@reelwalk/db";
import { fetchInstagramAudioById, instagramErrorMessage, isFakeInstagram } from "./instagram";
import { storageBlockedReason } from "./quotas";
import { postingProblem } from "./scheduled-posts";
import { putObject } from "./storage";

/**
 * Private copies of Instagram sounds, for editing a reel against the real
 * sound (ADR 0019). Choosing a sound fetches a fresh preview link for it
 * (GET /{audio-id}), downloads the preview on the server (the browser cannot
 * read Instagram's CDN: no CORS) and keeps it in the workspace's storage as
 * an AUDIO asset flagged with the sound's id. From there the editor treats it
 * like any song: it plays in the preview, its tempo is found in the browser,
 * cuts snap to its beat.
 *
 * The copy is never rendered into an export (reelRenderPlan in @reelwalk/core
 * drops it) and never published: Instagram attaches its own sound by id.
 */

/** Why this workspace cannot use Instagram's sounds here, in words with a next step, or null when it can. */
export async function instagramSoundProblem(workspaceId: string): Promise<string | null> {
  const problem = await postingProblem(workspaceId);
  if (problem) return problem;
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } } });
  if (!account) return "Connect an Instagram professional account on the Account tab to use Instagram's sounds.";
  if (account.expiresAt && account.expiresAt.getTime() < Date.now()) return "Your Instagram connection has expired. Reconnect it on the Account tab.";
  return null;
}

export type SoundAssetResult = { ok: true; asset: MediaAsset } | { ok: false; error: string };

type Downloaded = { bytes: Buffer; contentType: string; title: string | null; artist: string | null };

/** Reads at most `limit` bytes of a response body; null when it is bigger. */
async function readCapped(response: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A fresh preview of the sound, straight from Instagram (or the pretend one). */
async function downloadPreview(workspaceId: string, audioId: string, type: InstagramAudioType): Promise<Downloaded | string> {
  if (isFakeInstagram()) {
    const track = FAKE_INSTAGRAM_AUDIO.find((entry) => entry.id === audioId);
    if (!track) return "That sound is not in the pretend Instagram library.";
    return { bytes: Buffer.from(fakeInstagramSoundWav()), contentType: "audio/wav", title: track.title, artist: track.artist };
  }

  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } } });
  if (!account) return "Connect an Instagram professional account first (Account tab).";
  let previewUrl: string | null = null;
  let title: string | null = null;
  let artist: string | null = null;
  try {
    // Links in search results expire, so always ask for a fresh one by id.
    const [track] = await fetchInstagramAudioById({ igUserId: account.externalId, token: account.accessToken, id: audioId, type });
    previewUrl = track?.previewUrl ?? null;
    title = track?.title ?? null;
    artist = track?.artist ?? null;
  } catch (error) {
    console.error("instagram sound: lookup failed", error);
    return instagramErrorMessage(error, "Instagram's sound library did not answer. Try again in a moment.");
  }
  if (!previewUrl) return "Instagram has no preview of this sound to edit with. Pick another, or add it on the export screen.";

  try {
    const response = await fetch(previewUrl, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
    if (!response.ok) return `Instagram's preview of this sound did not download (${response.status}). Try again.`;
    const bytes = await readCapped(response, INSTAGRAM_PREVIEW_MAX_BYTES);
    if (!bytes || bytes.byteLength === 0) return "Instagram's preview of this sound is too large to edit with.";
    return { bytes, contentType: response.headers.get("content-type") ?? "audio/mp4", title, artist };
  } catch (error) {
    console.error("instagram sound: preview download failed", error);
    return "Instagram's preview of this sound did not download. Try again in a moment.";
  }
}

/**
 * The workspace's copy of a sound, made on first use. Choosing the same sound
 * again returns the same asset without asking Instagram. Never throws.
 */
export async function ensureInstagramSoundAsset(
  workspaceId: string,
  sound: { audioId: string; type: InstagramAudioType; title: string; artist: string | null },
): Promise<SoundAssetResult> {
  const existing = await prisma.mediaAsset.findUnique({ where: { workspaceId_instagramAudioId: { workspaceId, instagramAudioId: sound.audioId } } });
  if (existing) return { ok: true, asset: existing };

  const downloaded = await downloadPreview(workspaceId, sound.audioId, sound.type);
  if (typeof downloaded === "string") return { ok: false, error: downloaded };
  const title = (downloaded.title ?? sound.title).slice(0, 200);
  const artist = (downloaded.artist ?? sound.artist)?.slice(0, 200) ?? null;
  const full = await storageBlockedReason(workspaceId, downloaded.bytes.byteLength, `“${title}”`);
  if (full) return { ok: false, error: full };

  const format = instagramPreviewFormat(downloaded.contentType);
  const objectKey = instagramPreviewKeyFor(workspaceId, sound.audioId, format.extension);
  try {
    await putObject(objectKey, downloaded.bytes, format.contentType);
    // Two taps at once both download; the unique (workspace, sound) keeps one row.
    const asset = await prisma.mediaAsset.upsert({
      where: { workspaceId_instagramAudioId: { workspaceId, instagramAudioId: sound.audioId } },
      update: {},
      create: {
        workspaceId,
        kind: "AUDIO",
        objectKey,
        contentType: format.contentType,
        fileName: title,
        sizeBytes: downloaded.bytes.byteLength,
        // Measured in the browser once it has decoded the file (analyseInstagramSound).
        durationMs: null,
        instagramAudioId: sound.audioId,
        instagramTitle: title,
        instagramArtist: artist,
      },
    });
    return { ok: true, asset };
  } catch (error) {
    console.error("instagram sound: could not store the preview", error);
    return { ok: false, error: "Could not keep a copy of this sound to edit with. Try again." };
  }
}
