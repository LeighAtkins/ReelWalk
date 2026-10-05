"use client";

import { useEffect, useMemo, useState } from "react";
import type { Line } from "@/lib/types";
import { Ja } from "./Ja";
import { usePlaylist } from "./LineList";
import { PlayIcon, StopIcon } from "./Speak";

export interface Playlist {
  id: string;
  group: string;
  title: string;
  lines: Line[];
}

/** A hands-free player: one big current line, play or shadow through a whole list. */
export function Listen({ playlists }: { playlists: Playlist[] }) {
  const [id, setId] = useState(playlists[0]?.id ?? "");
  const pl = playlists.find((p) => p.id === id) ?? playlists[0];
  const texts = useMemo(() => pl.lines.map((l) => l.ja), [pl]);
  const list = usePlaylist(texts);
  const [showEn, setShowEn] = useState(true);
  const shown = list.index >= 0 ? pl.lines[list.index] : pl.lines[0];
  const groups = [...new Set(playlists.map((p) => p.group))];

  useEffect(() => {
    list.halt();
    // Switching lists stops playback.
  }, [id]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <select value={id} onChange={(e) => setId(e.target.value)} aria-label="What to listen to">
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {playlists
              .filter((p) => p.group === g)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.lines.length})
                </option>
              ))}
          </optgroup>
        ))}
      </select>

      <div className="drill-q" style={{ minHeight: 220, justifyContent: "space-between" }}>
        <p className="step-count" style={{ color: "#b7c0cb" }}>
          {list.index >= 0 ? `${list.index + 1} / ${pl.lines.length}` : `${pl.lines.length} lines`}
          {list.mode === "shadow" ? " · repeat after each line" : ""}
        </p>
        <p className="qa-q">
          <Ja text={shown.ja} />
        </p>
        {showEn && <p className="qa-qen">{shown.en}</p>}
      </div>

      <div className="row wrap">
        {list.mode ? (
          <button type="button" className="btn btn-ink" onClick={list.halt}>
            <StopIcon /> Stop
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-ink" onClick={() => list.play("listen")}>
              <PlayIcon /> Listen
            </button>
            <button type="button" className="btn" onClick={() => list.play("shadow")}>
              Shadow
            </button>
          </>
        )}
        <label className="switch" style={{ marginLeft: "auto" }}>
          <input type="checkbox" checked={showEn} onChange={(e) => setShowEn(e.target.checked)} />
          <span>English</span>
        </label>
      </div>
      <p className="note">Keep the screen on while listening: phones pause the speech engine when they lock.</p>
    </div>
  );
}
