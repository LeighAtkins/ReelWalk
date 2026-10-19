import type { Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

export type DirectorEvidence = { assetId: string; timesMs: number[]; image: string };

function event(target: HTMLVideoElement, name: "loadeddata" | "seeked", action: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(name, done); target.removeEventListener("error", failed); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("This video could not be sampled. Try refreshing its media link.")); };
    const timer = setTimeout(failed, 20_000);
    target.addEventListener(name, done, { once: true }); target.addEventListener("error", failed, { once: true }); action();
  });
}

/** Mechanical source sampling. It makes no creative choices or claims about playback. */
export async function captureDirectorEvidence(timeline: Timeline, assets: LibraryAsset[], candidates: string[], progress: (message: string) => void) {
  const byId = new Map(assets.map(a => [a.id, a]));
  const ids = [...new Set([...timeline.clips.filter(c => byId.get(c.assetId)?.isAiGenerated).map(c => c.assetId), ...candidates, ...timeline.clips.map(c => c.assetId)])].slice(0, 10);
  const result: DirectorEvidence[] = [];
  const skipped: string[] = [];
  for (const [i, id] of ids.entries()) {
    const asset = byId.get(id);
    try {
    if (!asset || !["IMAGE", "VIDEO"].includes(asset.kind) || asset.isPano) continue;
    progress(`Opus is looking through your clips (${i + 1} of ${ids.length})…`);
    if (asset.kind === "IMAGE") {
      const image = new Image(); image.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { image.src = ""; reject(new Error("Reference image timed out.")); }, 20_000);
        image.onload = () => { clearTimeout(timer); resolve(); };
        image.onerror = () => { clearTimeout(timer); reject(new Error("Reference image could not be sampled.")); };
        image.src = asset.url;
      });
      const canvas = document.createElement("canvas"), scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Image capture is unavailable.");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      result.push({ assetId: id, timesMs: [0], image: canvas.toDataURL("image/jpeg", .78) });
      continue;
    }
    if (!asset.durationMs) continue;
    const video = document.createElement("video"); video.crossOrigin = "anonymous"; video.preload = "auto"; video.muted = true;
    try {
      await event(video, "loadeddata", () => { video.src = asset.url; video.load(); });
      const end = Math.max(0, Math.min(asset.durationMs, video.duration * 1000) - 80);
      const windows = timeline.clips.filter(c => c.assetId === id);
      const dense = candidates.includes(id) || asset.isAiGenerated;
      const count = Math.min(candidates.includes(id) ? 24 : 40, Math.max(1, Math.ceil(end / 250)));
      const timesMs = dense ? Array.from({ length: count }, (_, n) => Math.round(count === 1 ? 0 : n * end / (count - 1)))
        : [...new Set(windows.flatMap(c => [c.sourceStartMs + 50, (c.sourceStartMs + c.sourceEndMs) / 2, c.sourceEndMs - 80]).map(t => Math.round(Math.min(end, Math.max(0, t)))))];
      if (!timesMs.length) timesMs.push(0);
      const width = 160, height = 284, label = 22, columns = Math.min(6, timesMs.length);
      const canvas = document.createElement("canvas"); canvas.width = columns * width; canvas.height = Math.ceil(timesMs.length / columns) * (height + label);
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Your browser cannot capture source frames.");
      ctx.fillStyle = "#111"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const captured: number[] = [];
      for (const [n, time] of timesMs.entries()) {
        // One stalled seek is retried once; after that the frames already captured are kept.
        if (Math.abs(video.currentTime * 1000 - time) > 5) {
          try { await event(video, "seeked", () => { video.currentTime = time / 1000; }); }
          catch { try { await event(video, "seeked", () => { video.currentTime = Math.max(0, time - 40) / 1000; }); } catch { break; } }
        }
        captured.push(time);
        const x = n % columns * width, y = Math.floor(n / columns) * (height + label);
        ctx.fillStyle = "white"; ctx.font = "14px sans-serif"; ctx.fillText(`${(time / 1000).toFixed(2)}s`, x + 4, y + 16);
        const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
        ctx.drawImage(video, x + (width - video.videoWidth * scale) / 2, y + label + (height - video.videoHeight * scale) / 2, video.videoWidth * scale, video.videoHeight * scale);
      }
      if (!captured.length) throw new Error("No frames could be read.");
      result.push({ assetId: id, timesMs: captured, image: canvas.toDataURL("image/jpeg", .78) });
    } finally { video.removeAttribute("src"); video.load(); }
    } catch { skipped.push(asset?.fileName ?? id); }
  }
  if (!result.length) throw new Error("None of the clips could be read. Check your connection and try again.");
  if (skipped.length) progress(`Opus could not read ${skipped.length} ${skipped.length === 1 ? "clip" : "clips"} and will review the rest.`);
  return result;
}
