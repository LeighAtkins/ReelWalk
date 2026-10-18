"use client";

import { useState } from "react";
import type { InstagramAudioChoice } from "@reelwalk/core";
import { ExportStage, ExportVideo, PlayWithSound } from "./export-sound";

/** Remounting the stage stops the other soundtrack and restarts both comparisons at zero. */
export function SoundComparison({ src, sound }: { src: string; sound: InstagramAudioChoice | null }) {
  const [original, setOriginal] = useState(false);
  const showOriginal = original || !sound;
  return (
    <div className="sound-comparison" data-testid="sound-comparison">
      <div className="segmented" role="group" aria-label="Compare soundtracks">
        <button type="button" aria-pressed={showOriginal} onClick={() => setOriginal(true)}>Original export</button>
        <button type="button" aria-pressed={!showOriginal} disabled={!sound} onClick={() => setOriginal(false)}>Instagram mix</button>
      </div>
      <ExportStage key={`${showOriginal ? "original" : "mix"}-${sound?.audioId ?? "none"}-${sound?.videoVolume ?? 0}`}>
        <ExportVideo src={src} originalAudio={showOriginal} />
        {!showOriginal && sound ? <PlayWithSound sound={sound} /> : <p className="muted small">Play the video to hear its original exported audio.</p>}
      </ExportStage>
    </div>
  );
}
