"use client";

import { useId } from "react";
import { DEFAULT_ENERGY, ENERGY_STOPS, type Music } from "@reelwalk/core";

/**
 * Editing to the beat (ADR 0059), where the studio taps the music: one
 * Energy control (chill to hype) that cuts the whole reel to the song, and
 * "On the beat", which puts title entrances, bursts, whips and the
 * presenter's pass on the bar. Nothing else: the plan's details (shot
 * lengths per section, the hero on the drop) are the engine's job.
 */
export function BeatControl({ music, measuring, onEnergy, onOnBeat, onRamps, onSpeedRamps }: {
  music: Music;
  /** Set while the clips' motion or the song's bars are still being measured. */
  measuring: boolean;
  /** The reel recut at this energy, 0 to 1 (one undo step per drag). */
  onEnergy(energy: number): void;
  onOnBeat(on: boolean): void;
  /** "Ramp into cuts" (ADR 0067): shots in the build and the drop speed up into their cuts. */
  onRamps?: (on: boolean) => void;
  /** "Speed-ramp the strong cuts" (ADR 0073): the cuts on the build's and the drop's downbeats become speed-ramp transitions. Off by default. */
  onSpeedRamps?: (on: boolean) => void;
}) {
  const id = useId();
  const energy = music.energy ?? DEFAULT_ENERGY;
  const stop = ENERGY_STOPS.reduce((best, item, index) => (Math.abs(item.value - energy) < Math.abs(ENERGY_STOPS[best].value - energy) ? index : best), 0);
  const on = music.onBeat === true;
  return (
    <div className="beat-control" data-testid="beat-control">
      <div className="field">
        <span className="field-row">
          <label htmlFor={id}>Energy</label>
          <output htmlFor={id} data-testid="beat-energy-label">{music.energy === undefined ? "Not set" : ENERGY_STOPS[stop].label}</output>
        </span>
        <input
          id={id}
          type="range"
          min={0}
          max={ENERGY_STOPS.length - 1}
          step={1}
          value={stop}
          aria-valuetext={ENERGY_STOPS[stop].label}
          onChange={(event) => onEnergy(ENERGY_STOPS[Number(event.target.value)].value)}
          data-testid="beat-energy"
        />
        <span className="beat-scale small muted" aria-hidden="true">
          <span>Chill</span>
          <span>{measuring ? "Listening…" : ""}</span>
          <span>Hype</span>
        </span>
      </div>
      <button type="button" role="switch" aria-checked={on} className="beat-switch" onClick={() => onOnBeat(!on)} data-testid="beat-on-beat">
        <span>On the beat</span>
        <span className="beat-switch-track" aria-hidden="true" />
      </button>
      {onRamps ? (
        <button type="button" role="switch" aria-checked={music.ramps === true} className="beat-switch" onClick={() => onRamps(music.ramps !== true)} data-testid="beat-ramps">
          <span>Ramp into cuts</span>
          <span className="beat-switch-track" aria-hidden="true" />
        </button>
      ) : null}
      {onSpeedRamps ? (
        <button type="button" role="switch" aria-checked={music.speedRamps === true} className="beat-switch" onClick={() => onSpeedRamps(music.speedRamps !== true)} data-testid="beat-speed-ramps">
          <span>Speed-ramp the strong cuts</span>
          <span className="beat-switch-track" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
