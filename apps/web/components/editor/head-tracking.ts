import { makeHeadLock, trackFace, type Clip, type Gray, type HeadLock } from '@reelwalk/core';
import { loadVideo, releaseVideo, seekVideo, luminance } from './frame-service';

/** Raw source coordinates, independent of the clip's previous crop or move. */
export async function trackHead(src: string, clip: Clip, seed: { x0: number; y0: number; x1: number; y1: number }, signal: AbortSignal, progress: (p: number) => void): Promise<HeadLock> {
  if (clip.sourceEndMs - clip.sourceStartMs > 12000) throw new Error('Trim the source section to 12 seconds or less before tracking.');
  const video = await loadVideo(src);
  try {
    const width = 270, height = Math.round(width * video.videoHeight / video.videoWidth);
    if (height > 600) throw new Error('Use a standard portrait or landscape video.');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const frames: Gray[] = [], times: number[] = [];
    const count = Math.ceil((clip.sourceEndMs - clip.sourceStartMs) / (1000 / 24));
    for (let i = 0; i <= count; i++) {
      signal.throwIfAborted();
      const ms = Math.min(clip.sourceEndMs - 42, clip.sourceStartMs + i * 1000 / 24);
      if (times.length && ms <= times.at(-1)!) break;
      await seekVideo(video, ms + 1);
      ctx.drawImage(video, 0, 0, width, height); frames.push(luminance(canvas)); times.push(ms);
      progress(.8 * i / count);
    }
    signal.throwIfAborted();
    await new Promise(r => setTimeout(r, 0));
    const samples = trackFace(frames, times, seed, { window: 5, minCorner: 2, maxPoints: 60 });
    signal.throwIfAborted();
    if (!samples) throw new Error('Could not follow this head. Fit the box closely around the face and try again.');
    const lock = makeHeadLock(samples, { width: video.videoWidth, height: video.videoHeight }, clip.sourceStartMs, clip.sourceEndMs);
    progress(1); return lock;
  } finally { releaseVideo(video); }
}
