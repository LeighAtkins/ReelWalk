import { clipSourceAvailability, type Clip } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Editor-only provenance and trim capacity; never appears in the exported reel. */
export function ClipSourceInfo({ clip, asset, onTrim }: { clip: Clip; asset?: LibraryAsset; onTrim?: () => void }) {
  if (clip.kind !== "VIDEO") return null;
  const available = clipSourceAvailability(clip, asset?.durationMs);
  return (
    <div className="clip-source-info" data-testid="clip-source-info">
      <div className="clip-source-heading">
        {asset?.isAiGenerated ? <span className="ai-source-badge">AI generated</span> : <strong>Video clip</strong>}
        <span>{seconds(available.usedMs)} on reel</span>
        <span>{available.sourceMs === null ? "Source length unknown" : `${seconds(available.sourceMs)} full source`}</span>
        {onTrim ? <button type="button" className="btn btn-quiet" onClick={onTrim}>Trim / extend</button> : null}
      </div>
      {available.afterMs !== null ? (
        <p>{seconds(available.beforeMs)} available before · {seconds(available.afterMs)} after
          {clip.speed !== 1 ? ` · Up to ${seconds(available.fullLengthMs!)} on reel at ${clip.speed}×` : ""}.
        </p>
      ) : null}
    </div>
  );
}
