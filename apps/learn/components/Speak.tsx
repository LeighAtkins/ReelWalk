"use client";

import { useEffect, useState } from "react";
import { speak, stop } from "@/lib/speech";
import { useSettings } from "@/lib/settings";

let activeSetter: ((v: boolean) => void) | null = null;

/** A round play button that reads one piece of Japanese aloud. */
export function Speak({ text, label = "Play", size = "md", rate }: { text: string; label?: string; size?: "sm" | "md" | "lg"; rate?: number }) {
  const [s] = useSettings();
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => {
    if (activeSetter === setPlaying) activeSetter = null;
  }, []);

  async function onClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (playing) {
      stop();
      setPlaying(false);
      return;
    }
    activeSetter?.(false);
    activeSetter = setPlaying;
    setPlaying(true);
    await speak(text, { rate: rate ?? s.rate, voiceURI: s.voiceURI });
    if (activeSetter === setPlaying) setPlaying(false);
  }

  return (
    <button
      type="button"
      className={`speak speak-${size}`}
      data-playing={playing || undefined}
      onClick={onClick}
      aria-label={playing ? "Stop" : label}
      title={label}
    >
      {playing ? <StopIcon /> : <PlayIcon />}
    </button>
  );
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
