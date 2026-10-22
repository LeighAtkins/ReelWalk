import { SFX_SOUNDS, sfxAssetKey, sfxSoundsUsed, type Timeline } from "@reelwalk/core";
import type { ReelAsset } from "./types";

// Kept apart from the composition, like types.ts: the worker's Node code imports this.

/** The bundled sound files are served under this path by the web app and the worker's bundle. */
export const SFX_PUBLIC_DIR = "sfx";

/**
 * The asset entries the composition plays a reel's sound design from
 * (ADR 0066), keyed by `sfx:<sound>`. `srcFor` turns a file name into what
 * the environment can fetch: the web app's `/sfx/<file>` route, the worker's
 * `sfx/<file>` under the bundle's public dir (`staticFile`).
 */
export function sfxAssets(timeline: Pick<Timeline, "sfx">, srcFor: (file: string) => string = (file) => `${SFX_PUBLIC_DIR}/${file}`): Record<string, ReelAsset> {
  const assets: Record<string, ReelAsset> = {};
  for (const id of sfxSoundsUsed(timeline)) assets[sfxAssetKey(id)] = { src: srcFor(SFX_SOUNDS[id].file), kind: "AUDIO" };
  return assets;
}
