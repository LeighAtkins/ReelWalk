"use client";

import { clipStartsMs, reelDropMs, timelineDurationMs, type AudioAnalysis, type Timeline } from "@reelwalk/core";

/**
 * Sound design (ADR 0066), where the studio taps the music: one switch that
 * places the bundled sounds by rule (a whoosh under every whip, a riser and
 * soft impact into the reveal, ambience under the rooms that call for it)
 * and, when the song has been analysed and a shot is selected, one button
 * that puts the song's drop on the cut into that shot. Nothing else: which
 * sound goes where is the rule's job, and agents place by hand over HTTP.
 */
export function SoundControl({ timeline, analysis, cut, onSoundDesign, onDropOnCut }: {
  timeline: Timeline;
  /** The song's analysis, when known. */
  analysis: AudioAnalysis | null;
  /** The selected shot's index (1 = the second shot; its cut is the start of the shot), or null. */
  cut: number | null;
  /** Sound design placed (with the drop in reel time, when known, so the riser ends on it) or removed. */
  onSoundDesign(on: boolean, dropMs: number | null): void;
  onDropOnCut(cut: number, dropSongMs: number): void;
}) {
  const count = timeline.sfx?.length ?? 0;
  const on = count > 0;
  const total = timelineDurationMs(timeline);
  const dropSongMs = analysis?.drop?.atMs ?? null;
  const dropMs = reelDropMs(dropSongMs, timeline.music, total);
  const starts = clipStartsMs(timeline);
  const cutMs = cut !== null && cut < starts.length ? starts[cut] : null;
  const onTheDrop = dropMs !== null && cutMs !== null && Math.abs(cutMs - dropMs) <= 120;
  return (
    <div className="sound-control" data-testid="sound-control">
      <button type="button" role="switch" aria-checked={on} className="beat-switch" onClick={() => onSoundDesign(!on, dropMs)} data-testid="sound-design">
        <span>
          Sound design
          <span className="muted small" style={{ display: "block", fontWeight: 400 }}>
            {on ? `${count} sound${count === 1 ? "" : "s"}: whooshes, riser, ambience` : "Whooshes on whips, a riser into the reveal, ambience"}
          </span>
        </span>
        <span className="beat-switch-track" aria-hidden="true" />
      </button>
      {dropSongMs !== null ? (
        cut !== null && cutMs !== null ? (
          <button type="button" className="btn btn-block" onClick={() => onDropOnCut(cut, dropSongMs)} disabled={onTheDrop} data-testid="drop-on-cut">
            {onTheDrop ? `The drop is on cut ${cut}` : `Put the drop on cut ${cut} (${(cutMs / 1000).toFixed(1)} s)`}
          </button>
        ) : (
          <p className="muted small" data-testid="drop-hint">
            The song drops at {(dropSongMs / 1000).toFixed(1)} s{dropMs !== null ? ` (${(dropMs / 1000).toFixed(1)} s into the reel)` : ""}. Select a shot to put the drop on its cut.
          </p>
        )
      ) : null}
    </div>
  );
}
