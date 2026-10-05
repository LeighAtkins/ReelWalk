"use client";

import { useEffect, useRef, useState } from "react";
import type { Line } from "@/lib/types";
import { currentGeneration, shadowGap, speakNext, stop, wait } from "@/lib/speech";
import { useSettings } from "@/lib/settings";
import { Ja } from "./Ja";
import { Speak, PlayIcon, StopIcon } from "./Speak";

type Mode = "listen" | "shadow";

/** Keeps the screen on during long playback; phones pause speech when they lock. */
async function keepAwake(): Promise<WakeLockSentinel | null> {
  try {
    return "wakeLock" in navigator ? await navigator.wakeLock.request("screen") : null;
  } catch {
    return null;
  }
}

/** Plays a list of lines one after another; "shadow" leaves a gap to repeat each line. */
/** `rate` overrides the speed setting, e.g. to play slowly for a first listen. */
export function usePlaylist(texts: string[], rate?: number) {
  const [s] = useSettings();
  const [index, setIndex] = useState(-1);
  const [mode, setMode] = useState<Mode | null>(null);
  const run = useRef(0);

  useEffect(() => () => stop(), []);

  async function play(m: Mode, from = 0) {
    stop();
    const gen = currentGeneration();
    const mine = ++run.current;
    // Not awaited: iOS only allows speech started synchronously inside the tap.
    const lock = keepAwake();
    setMode(m);
    for (let i = from; i < texts.length; i++) {
      setIndex(i);
      const ok = await speakNext(texts[i], { rate: rate ?? s.rate, voiceURI: s.voiceURI }, gen);
      if (!ok) break;
      const gap = m === "shadow" ? shadowGap(texts[i], rate ?? s.rate) : 650;
      if (!(await wait(gap, gen))) break;
    }
    lock.then((l) => l?.release()).catch(() => {});
    // Another play of this list may have started meanwhile; it owns the state then.
    if (mine === run.current) {
      setIndex(-1);
      setMode(null);
    }
  }

  function halt() {
    stop();
    setIndex(-1);
    setMode(null);
  }

  return { index, mode, play, halt };
}

export function PlayAll({ list }: { list: ReturnType<typeof usePlaylist> }) {
  return (
    <div className="playall">
      {list.mode ? (
        <button type="button" className="btn btn-ink" onClick={list.halt}>
          <StopIcon /> Stop
        </button>
      ) : (
        <>
          <button type="button" className="btn btn-ink" onClick={() => list.play("listen")}>
            <PlayIcon /> Play all
          </button>
          <button type="button" className="btn" onClick={() => list.play("shadow")} title="Pauses after each line so you can repeat it">
            Shadowing
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Spoken lines with a play button each, English below, and play-all.
 * `practice` adds a memorise mode that hides the Japanese until tapped.
 */
export function LineList({ lines, practice = false, numbered = false, controls = true }: { lines: Line[]; practice?: boolean; numbered?: boolean; controls?: boolean }) {
  const list = usePlaylist(lines.map((l) => l.ja));
  const [hide, setHide] = useState(false);
  const [shown, setShown] = useState<Set<number>>(new Set());
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [s] = useSettings();

  function toggle(set: Set<number>, i: number) {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  }

  return (
    <div className="lines">
      {controls && (
        <div className="lines-bar">
          <PlayAll list={list} />
          {practice && (
            <label className="switch">
              <input type="checkbox" checked={hide} onChange={(e) => { setHide(e.target.checked); setShown(new Set()); }} />
              <span>Hide Japanese</span>
            </label>
          )}
        </div>
      )}
      <ol className={numbered ? "numbered" : undefined}>
        {lines.map((line, i) => {
          const masked = hide && !shown.has(i);
          const enHidden = s.english === "tap" && !revealed.has(i);
          return (
            <li key={i} className="line" data-current={list.index === i || undefined}>
              <Speak text={line.ja} />
              <div className="line-body">
                {masked ? (
                  <button type="button" className="mask" onClick={() => setShown(toggle(shown, i))}>
                    Say it, then tap to check
                  </button>
                ) : (
                  <p className="ja-line" onClick={() => hide && setShown(toggle(shown, i))}>
                    <Ja text={line.ja} />
                  </p>
                )}
                <p
                  className="en-line"
                  data-hidden={enHidden || undefined}
                  onClick={() => setRevealed(toggle(revealed, i))}
                >
                  {line.en}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
