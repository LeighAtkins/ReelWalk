import { fakeInstagramSoundWav } from "@reelwalk/core";
import { isFakeInstagram } from "@/lib/instagram";

export const dynamic = "force-dynamic";

/**
 * The pretend Instagram's preview link (DEV_FAKE_INSTAGRAM only): every
 * canned sound previews as the same short click track, so the picker's play
 * button works offline. Elsewhere the endpoint does not exist.
 */
export async function GET(): Promise<Response> {
  if (!isFakeInstagram()) return new Response(null, { status: 404 });
  const body = fakeInstagramSoundWav();
  return new Response(body.buffer as ArrayBuffer, {
    headers: { "content-type": "audio/wav", "content-length": String(body.byteLength), "cache-control": "public, max-age=3600" },
  });
}
