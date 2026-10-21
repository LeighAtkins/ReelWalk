"use client";

import { useEffect, useState } from "react";
import type { InstagramAudioTrack, MusicMoodId, PopularPick } from "@reelwalk/core";
import { popularSoundsFor } from "@/lib/instagram-sounds-client";
import { CheckIcon, MusicIcon } from "./icons";

/**
 * "Popular now" (ADR 0058): the first row of the Music sheet's Instagram
 * music. Up to five sounds matched to songs that big playlists of the reel's
 * mood carry, each with one line on why. Tapping one is the same as tapping
 * it in the search results. Nothing is shown until there is something to
 * show, and nothing at all when the chart is empty or cannot be read.
 */
export function PopularSounds({
  moods,
  reelMs,
  selectedId,
  busyId,
  disabled,
  onSelect,
}: {
  moods: MusicMoodId[];
  reelMs: number;
  selectedId: string | null;
  busyId: string | null;
  disabled: boolean;
  onSelect(track: InstagramAudioTrack): void;
}) {
  const [picks, setPicks] = useState<PopularPick[]>([]);
  const moodKey = moods.join(",");
  // Asked again only when the mood changes or the reel's length changes by a few seconds, not on every edit.
  const lengthBucket = Math.round(reelMs / 5000);

  useEffect(() => {
    let live = true;
    void popularSoundsFor({ moods: moodKey ? (moodKey.split(",") as MusicMoodId[]) : [], reelMs: lengthBucket * 5000 }).then((result) => {
      if (live) setPicks(result);
    });
    return () => {
      live = false;
    };
  }, [moodKey, lengthBucket]);

  if (picks.length === 0) return null;
  return (
    <section className="popular-sounds" aria-labelledby="popular-sounds-title" data-testid="popular-sounds">
      <h3 id="popular-sounds-title" className="popular-sounds-title">
        Popular now
      </h3>
      <ul className="sound-list">
        {picks.map((pick) => {
          const isSelected = selectedId === pick.track.id;
          const isBusy = busyId === pick.track.id;
          return (
            <li key={pick.track.id} className="sound-row popular-row" data-selected={isSelected || undefined}>
              <button
                type="button"
                className="sound-pick"
                aria-pressed={isSelected}
                aria-busy={isBusy || undefined}
                disabled={disabled}
                onClick={() => onSelect(pick.track)}
                data-testid="popular-sound"
                data-audio-id={pick.track.id}
              >
                <span className="sound-cover" aria-hidden="true">
                  <MusicIcon size={20} />
                  {isSelected ? (
                    <span className="sound-tick">
                      <CheckIcon size={16} />
                    </span>
                  ) : null}
                </span>
                <span className="sound-meta">
                  <span className="sound-title">{pick.track.title}</span>
                  <span className="muted small sound-artist">
                    {isBusy ? "Getting the sound…" : (
                      <>
                        {pick.track.artist ?? "Unknown artist"}
                        {pick.bpm ? <span className="timecode"> · {Math.round(pick.bpm)} bpm</span> : null}
                      </>
                    )}
                  </span>
                  <span className="muted small popular-why" data-testid="popular-why">
                    {pick.why}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
