"use client";

import { useEffect } from "react";
import { useLocal } from "./store";

export interface Settings {
  /** Show furigana over annotated kanji. */
  furigana: boolean;
  /** "show": English under every line. "tap": hidden until the line is tapped. */
  english: "show" | "tap";
  /** Speech rate, 1 = normal. */
  rate: number;
  /** Chosen Japanese voice, or null for the best available. */
  voiceURI: string | null;
}

export const DEFAULT_SETTINGS: Settings = { furigana: true, english: "show", rate: 0.9, voiceURI: null };

export function useSettings() {
  const [settings, setSettings] = useLocal<Settings>("settings", DEFAULT_SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const patch = (p: Partial<Settings>) => setSettings((prev) => ({ ...DEFAULT_SETTINGS, ...prev, ...p }));
  return [merged, patch] as const;
}

/** Mirrors settings that CSS reacts to onto <html>. */
export function SettingsEffect() {
  const [s] = useSettings();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.furigana = s.furigana ? "on" : "off";
    root.dataset.english = s.english;
  }, [s.furigana, s.english]);
  return null;
}
