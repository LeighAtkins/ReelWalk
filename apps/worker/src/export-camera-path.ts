import { cameraAt, clipDurationMs, clipStartsMs, parseTimeline, REEL_FORMAT, timelineDurationMs } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";

/**
 * Prints where the camera is for every frame of a tour reel, as JSON: its
 * position on the floor plan, the way it faces, tilt and zoom. A renderer
 * outside the app (the Gaussian splat in infra/splat) can then fly exactly
 * the route the reel's 360 walk takes.
 *
 *   docker compose run --rm import-zind node_modules/.bin/tsx src/export-camera-path.ts <reel id> > path.json
 */
async function main() {
  const id = process.argv[2];
  const reel = id ? await prisma.reel.findUnique({ where: { id } }) : null;
  if (!reel) throw new Error(`No reel with id "${id}".`);
  const timeline = parseTimeline(reel.timeline);
  const plan = timeline.plan?.geometry ?? null;
  const starts = clipStartsMs(timeline);
  const fps = REEL_FORMAT.fps;
  const frames = Math.round((timelineDurationMs(timeline) * fps) / 1000);

  const poses = [];
  for (let frame = 0; frame < frames; frame++) {
    const ms = (frame * 1000) / fps;
    let index = timeline.clips.length - 1;
    while (index > 0 && starts[index] > ms) index--;
    const clip = timeline.clips[index];
    const pose = cameraAt(plan, timeline.clips[index - 1], clip, ms - starts[index], clipDurationMs(clip));
    poses.push({ x: pose.x, y: pose.y, heading: pose.heading, pitch: pose.pitch, fov: pose.fov });
  }
  process.stdout.write(JSON.stringify({ fps, width: REEL_FORMAT.width, height: REEL_FORMAT.height, poses }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
