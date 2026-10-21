/**
 * The smoke reel and its media (ADR 0042, 0053), shared by render-smoke.ts
 * (does every feature draw and encode, and pass acceptance?) and
 * frame-hashes.ts (did a refactor move a pixel? ADR 0046). Needs ffmpeg to
 * make the media; FFMPEG names another binary.
 */
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseTimeline, type Timeline } from "@reelwalk/core";
import { ffmpegBin } from "./acceptance/ffmpeg";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
/** Four seconds of a woman reading by a fire, 540×960 (Pexels 6984912; SOURCE.md). */
const REAL_CLIP = path.join(here, "..", "fixtures", "reader.mp4");

export async function makeMedia(dir: string): Promise<{ real: boolean }> {
  // Two short portrait clips with motion and detail (a tracker and a matte need something to look at), one still, one song.
  // The walking shot is a real person when the fixture is there: a matte and a title on a window need real pixels.
  const real = existsSync(REAL_CLIP);
  if (real) await copyFile(REAL_CLIP, path.join(dir, "walk.mp4"));
  else await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=4", "-vf", "hue=s=0.6", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", path.join(dir, "walk.mp4")]);
  await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "mandelbrot=size=1080x1920:rate=30", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", path.join(dir, "room.mp4")]);
  await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "smptebars=size=1080x1920:rate=1", "-frames:v", "1", path.join(dir, "photo.jpg")]);
  await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=12", "-c:a", "aac", "-b:a", "96k", path.join(dir, "song.m4a")]);
  // A 2:1 equirectangular still for a 360 shot.
  await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=2048x1024:rate=1", "-frames:v", "1", path.join(dir, "pano.jpg")]);
  return { real };
}

export function serve(dir: string): Promise<{ url: string; close(): void }> {
  const types: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".m4a": "audio/mp4" };
  const server = http.createServer(async (request, response) => {
    const file = path.join(dir, path.basename(request.url ?? "/"));
    try {
      const info = await stat(file);
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers.range ?? "");
      const start = range?.[1] ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) : info.size - 1;
      response.writeHead(range ? 206 : 200, {
        "content-type": types[path.extname(file)] ?? "application/octet-stream",
        "accept-ranges": "bytes", "access-control-allow-origin": "*",
        "content-length": end - start + 1, ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}),
      });
      createReadStream(file, { start, end }).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
  }));
}

/** Every feature at once: the cases that have broken production renders, and the ones that could. */
export function smokeTimeline(): Timeline {
  const quad = [0.3, 0.3, 0.7, 0.3, 0.7, 0.45, 0.3, 0.45];
  const moved = [0.32, 0.31, 0.72, 0.3, 0.72, 0.46, 0.32, 0.46];
  // A surface in perspective (narrower on the right), with two posts in front of it, one overlapping the other.
  const surface = [0.1, 0.2, 0.8, 0.26, 0.8, 0.5, 0.1, 0.56];
  const surfaceMoved = [0.12, 0.21, 0.82, 0.27, 0.82, 0.51, 0.12, 0.57];
  const bars = [[0.4, 0.2, 0.45, 0.2, 0.45, 0.56, 0.4, 0.56], [0.43, 0.2, 0.5, 0.2, 0.5, 0.56, 0.43, 0.56]];
  // The window behind the reader (first shot), and where a slow drift takes it by the cut.
  const window = [0.4, 0.05, 0.93, 0.05, 0.93, 0.2, 0.4, 0.2];
  const windowMoved = [0.38, 0.06, 0.91, 0.06, 0.91, 0.21, 0.38, 0.21];
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2500, transitionIn: "cut" },
      { id: "c2", assetId: "room", kind: "VIDEO", sourceStartMs: 200, sourceEndMs: 2600, transitionIn: "whip", whipDirection: "left", filter: "golden" },
      { id: "c3", assetId: "photo", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000, motion: "zoom-in", transitionIn: "cut" },
      { id: "c4", assetId: "walk", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 3000, speed: 1.5, zoom: 1.2, transitionIn: "cut" },
      // A 360 photo with its sweep.
      { id: "c5", assetId: "pano", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000, pano: { yawStart: -30, yawEnd: 30, pitch: 0, fov: 90 }, transitionIn: "fade" },
    ],
    texts: [
      // Words behind a person (matte), extruded: the first clip, where the matte mounts at frame 0.
      // At 0.9 s the reader passes in front of it (ADR 0055): the words cover her until then. Before 1 s, so that from
      // frame 30, where s2's woodpile tap starts tracking, she covers WELCOME again: that object matte belongs to s2 but
      // draws above every behind title (ADR 0046's order), and over exposed words it shows in s2's probe.
      { id: "w1", text: "WELCOME", startMs: 0, endMs: 2500, x: 0.5, y: 0.4, style: "headline", size: 1.4, animation: "pop", behind: true, depth: "extruded", passMs: 900 },
      // A pinned title painted on the window over the reader's head, on real footage (ADR 0053): the attachment check follows it.
      // The woodpile in front of her is tapped (ADR 0044), on the frame at 1 s, and tracked from there (ADR 0051); it is
      // well clear of the window, so the acceptance checks still see every letter of the title.
      // Embers in its plane (ADR 0055), drawn in front of and behind the letters.
      { id: "s2", text: "BY THE FIRE", startMs: 0, endMs: 2500, x: 0.66, y: 0.12, style: "headline", size: 1, animation: "none", blend: "surface", surface: window, particles: { kind: "embers", seed: 3 },
        occluders: [{ x: 0.6, y: 0.85, atMs: 1000 }],
        pin: { assetId: "walk", fromMs: 0, toMs: 2500, quad: window }, path: [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: window }, { t: 1, x: -0.02, y: 0.01, s: 1, r: 0, q: windowMoved }] },
      // A whole-shot planar pin that overlaps the next cut by a few frames (the React 300 case), painted on the surface, fading at the end.
      { id: "p1", text: "OCEAN VIEWS", startMs: 2500, endMs: 5000, x: 0.5, y: 0.38, style: "headline", size: 1.1, animation: "none", blend: "surface",
        pin: { assetId: "room", fromMs: 200, toMs: 2600, quad }, path: [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: quad }, { t: 0.6, x: 0.02, y: 0.01, s: 1.02, r: 0.5, q: moved }, { t: 1, x: 0.02, y: 0.01, s: 1.02, r: 0.5, q: moved, o: 0 }] },
      // A title painted inside a chosen surface, with posts cut out of it (ADR 0043/0044), two lines, on the same shot.
      { id: "s1", text: "STEP\nOUT", startMs: 2500, endMs: 4900, x: 0.45, y: 0.38, style: "headline", size: 1, animation: "none", blend: "surface", surface, bars,
        pin: { assetId: "room", fromMs: 200, toMs: 2600, quad: surface }, path: [{ t: 0, x: 0, y: 0, s: 1, r: 0, q: surface }, { t: 1, x: 0.02, y: 0.01, s: 1, r: 0, q: surfaceMoved }] },
      // A still on a photo with the typewriter, and a drifting tag.
      { id: "t1", text: "3 bed · 2 bath", startMs: 4900, endMs: 6900, x: 0.5, y: 0.8, style: "tag", animation: "type" },
      { id: "t2", text: "Just listed", startMs: 6900, endMs: 8200, x: 0.5, y: 0.2, style: "elegant", animation: "fade", path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.04, y: 0 }], particles: { kind: "snow" } },
    ],
    music: { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 108, beatOffsetMs: 0 },
    hook: { kind: "alert", durationMs: 1500, title: "New listing", body: "Beachfront, 3 bed", action: "See it" },
    logo: { assetId: "photo", corner: "top-right", size: 0.12 },
    details: { price: "$1.2m", address: "Bahia", beds: "3", baths: "2", area: "240 m²" },
  });
}
