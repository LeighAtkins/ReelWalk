"use client";

import { useEffect, useMemo, useState } from "react";
import type { AudioTrace, InstagramAudioChoice } from "@reelwalk/core";
import { PlayWithSound } from "./export-sound";

/**
 * Hear and see the mix before posting (ADR 0066). The strip draws what the
 * audio trace knows: the export's loudness every 250 ms, the song's beats
 * and drop, the cuts (off-beat ones marked) and where speech is. Under it,
 * the recommended post sound volume, and "Mix preview": the export's own
 * track with the Instagram sound mixed in at that level, so the mix heard
 * here is the mix Instagram will make.
 */

type Trace = AudioTrace & { exportJobId: string | null };

const LUFS_FLOOR = -60;
const HEIGHT = 72;
const WIDTH = 1000;

export function MixPreview({ reelId, sound, initial = null }: { reelId: string; sound: InstagramAudioChoice | null; /** The trace the page already read; without one it is fetched here. */ initial?: Trace | null }) {
  const [trace, setTrace] = useState<Trace | null>(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/reels/${encodeURIComponent(reelId)}/audio-trace`);
        const body = (await response.json()) as ({ ok: true } & Trace) | { ok: false; message: string };
        if (cancelled) return;
        if (!body.ok) setError(body.message);
        else setTrace(body);
      } catch {
        if (!cancelled) setError("Could not read the mix.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reelId, initial]);

  const mixed = useMemo<InstagramAudioChoice | null>(
    () => (sound && trace ? { ...sound, audioVolume: trace.recommended.audioVolume, videoVolume: trace.recommended.videoVolume } : null),
    [sound, trace],
  );

  if (error) {
    return (
      <p className="muted small" data-testid="mix-preview-error">
        {error}
      </p>
    );
  }
  if (!trace) return null;

  const { recommended, loudness } = trace;
  const x = (ms: number) => Math.max(0, Math.min(WIDTH, (ms / Math.max(1, trace.durationMs)) * WIDTH));
  const problems = trace.problems.slice(0, 4);

  return (
    <section className="mix-preview" data-testid="mix-preview" aria-label="Mix">
      <svg className="mix-strip" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="The export's loudness, beats, cuts and speech in time">
        <rect x={0} y={0} width={WIDTH} height={HEIGHT} className="mix-strip-bed" />
        {trace.speech.map((window, index) => (
          <rect key={`s${index}`} x={x(window.startMs)} y={0} width={Math.max(1, x(window.endMs) - x(window.startMs))} height={HEIGHT} className="mix-strip-speech" />
        ))}
        {loudness
          ? loudness.lufs.map((value, index) => {
              const level = Math.max(0, Math.min(1, (value - LUFS_FLOOR) / -LUFS_FLOOR));
              const height = level * (HEIGHT - 14);
              return <rect key={`l${index}`} x={x(index * loudness.stepMs)} y={HEIGHT - 8 - height} width={Math.max(1, x(loudness.stepMs) - 0.5)} height={height} className="mix-strip-level" />;
            })
          : null}
        {trace.beats.map((beat, index) => (
          <line key={`b${index}`} x1={x(beat)} x2={x(beat)} y1={HEIGHT - 6} y2={HEIGHT} className={trace.downbeats.includes(beat) ? "mix-strip-downbeat" : "mix-strip-beat"} />
        ))}
        {trace.cuts.map((cut) => (
          <line key={cut.clipId} x1={x(cut.atMs)} x2={x(cut.atMs)} y1={0} y2={HEIGHT} className={cut.offBeatMs !== null && cut.offBeatMs > 60 ? "mix-strip-cut mix-strip-cut-off" : "mix-strip-cut"} />
        ))}
        {trace.dropMs !== null ? <polygon points={`${x(trace.dropMs) - 6},0 ${x(trace.dropMs) + 6},0 ${x(trace.dropMs)},10`} className="mix-strip-drop" /> : null}
      </svg>
      <p className="small" data-testid="mix-recommendation">
        {sound ? (
          <>
            Post with the sound at <strong>{recommended.audioVolume}%</strong> and your reel&apos;s own sound at <strong>{recommended.videoVolume}%</strong>. {recommended.reason}
          </>
        ) : (
          <>No Instagram sound is chosen: the post goes out with the export&apos;s own track. {recommended.reason}</>
        )}
        {loudness?.integratedLufs != null ? (
          <span className="muted">
            {" "}
            Export: {loudness.integratedLufs} LUFS{loudness.truePeakDb != null ? `, ${loudness.truePeakDb} dBTP` : ""}.
          </span>
        ) : (
          <span className="muted"> The export&apos;s level has not been measured yet.</span>
        )}
      </p>
      {problems.length > 0 ? (
        <ul className="mix-problems small" data-testid="mix-problems">
          {problems.map((problem, index) => (
            <li key={index} data-kind={problem.kind}>
              {problem.detail}
            </li>
          ))}
        </ul>
      ) : null}
      {mixed ? <PlayWithSound sound={mixed} testId="mix-play" label="Mix preview" hint="The export's own track with the Instagram sound mixed in at the level above, as Instagram will mix it." /> : null}
    </section>
  );
}
