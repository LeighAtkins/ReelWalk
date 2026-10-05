"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { OPENING } from "@/content/game";
import { generalQA, topics } from "@/lib/content";
import { cues, question, type GameQuestion } from "@/lib/game/model";
import { stop } from "@/lib/speech";
import { useLocal } from "@/lib/store";
import { Ja } from "./Ja";
import { PlayAll, usePlaylist } from "./LineList";
import { Recorder } from "./Recorder";
import { Speak } from "./Speak";

/**
 * A gentle way into one answer: hear it slowly, repeat it in small chunks,
 * say each point from cue words, then say the whole thing from memory.
 */

const SLOW = 0.75;

const STEPS = [
  { id: "listen", ja: "聞く", en: "Listen", tip: "Just listen first. Notice where the voice pauses: that's where you can breathe too." },
  { id: "repeat", ja: "まねる", en: "Repeat", tip: "One point at a time. Play it, then say it out loud, pausing at each break. Slow and clear beats fast." },
  { id: "recall", ja: "思い出す", en: "Recall", tip: "Only cue words now. Say the point in your own rhythm, then check. Close enough counts!" },
  { id: "solo", ja: "本番", en: "Solo", tip: "Just the question. Record the whole answer, then compare. You've practised every piece already." },
] as const;

const CHEERS = ["いいですね！", "その調子！", "Nice and clear.", "Good pace.", "上手です！", "Keep going, you've got this."];

const REAL_SET = OPENING.map((o) => `o:${o.id}`);

interface Point {
  /** What to show, with the learner's words filled in. */
  ja: string;
  /** The original line, which has recorded audio. */
  say: string;
  en: string;
}

interface Progress {
  step: number;
  rating?: 1 | 2 | 3;
}

/** Splits a line at its commas, so it can be said one breath at a time. */
function chunks(ja: string): string[] {
  return ja.split(/(?<=、)/).filter((c) => c.trim());
}

/** The placeholders in an answer, like 【前職の会社名】. */
function blanks(q: GameQuestion): string[] {
  return [...new Set(q.a.flatMap((l) => l.ja.match(/【[^】]+】/g) ?? []))];
}

export function Coach() {
  const params = useSearchParams();
  const [id, setId] = useState(REAL_SET[0]);
  const [progress, setProgress] = useLocal<Record<string, Progress>>("coach", {});
  const [fills, setFills] = useLocal<Record<string, string>>("coach-fills", {});
  const [long, setLong] = useLocal<Record<string, boolean>>("coach-long", {});

  useEffect(() => {
    const q = params.get("q");
    if (q && question(q)) setId(q);
  }, [params]);

  const q = question(id);
  const p = progress[id] ?? { step: 0 };
  const [step, setStep] = useState(0);
  // Open each question at the step the learner reached.
  const reached = p.step;
  useEffect(() => {
    setStep(Math.min(reached, STEPS.length - 1));
    stop();
  }, [id, reached]);

  // Lines show the learner's own words in the 【】 blanks; audio plays the recorded original.
  const lines: Point[] = useMemo(
    () =>
      (q?.short && !long[id] ? q.short : q?.a)?.map((l) => ({
        ja: l.ja.replace(/【[^】]+】/g, (b) => (fills[b]?.trim() ? `【${fills[b].trim()}】` : b)),
        say: l.ja,
        en: l.en,
      })) ?? [],
    [q, fills, long, id],
  );

  if (!q) return null;
  const done = (n: number) => setProgress((all) => ({ ...all, [id]: { ...all[id], step: Math.max(all[id]?.step ?? 0, n) } }));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Picker id={id} onPick={setId} progress={progress} />

      <div className="question-card">
        <p className="checklist-head">{q.label.en}</p>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <Speak text={q.q.ja} />
          <p className="question-text">
            <Ja text={q.q.ja} />
          </p>
        </div>
        <p className="note">{q.q.en}</p>
      </div>

      {q.short && (
        <div className="seg" role="group" aria-label="Answer length">
          <button type="button" aria-pressed={!long[id]} onClick={() => setLong((l) => ({ ...l, [id]: false }))}>
            Short version ({q.short.length} points)
          </button>
          <button type="button" aria-pressed={!!long[id]} onClick={() => setLong((l) => ({ ...l, [id]: true }))}>
            Full ({q.a.length} points)
          </button>
        </div>
      )}

      <Blanks q={q} fills={fills} onFill={(b, v) => setFills((f) => ({ ...f, [b]: v }))} />

      <nav className="coach-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <button key={s.id} type="button" aria-current={step === i ? "step" : undefined} data-done={p.step > i || undefined} onClick={() => setStep(i)}>
            <span className="coach-step-n">{p.step > i ? "✓" : i + 1}</span>
            <span lang="ja">{s.ja}</span>
            <span className="coach-step-en">{s.en}</span>
          </button>
        ))}
      </nav>
      <p className="coach-tip">{STEPS[step].tip}</p>

      {step === 0 && <ListenStep key={`${id}${!!long[id]}`} lines={lines} onDone={() => (done(1), setStep(1))} />}
      {step === 1 && <RepeatStep key={`${id}${!!long[id]}`} lines={lines} onDone={() => (done(2), setStep(2))} />}
      {step === 2 && <RecallStep key={`${id}${!!long[id]}`} lines={lines} onDone={() => (done(3), setStep(3))} />}
      {step === 3 && (
        <SoloStep
          key={id}
          lines={lines}
          rating={p.rating}
          onRate={(r) => setProgress((all) => ({ ...all, [id]: { step: STEPS.length, rating: r } }))}
          onNext={() => {
            const i = REAL_SET.indexOf(id);
            if (i >= 0 && i < REAL_SET.length - 1) setId(REAL_SET[i + 1]);
          }}
        />
      )}
    </div>
  );
}

function Picker({ id, onPick, progress }: { id: string; onPick: (id: string) => void; progress: Record<string, Progress> }) {
  const others = useMemo(
    () => [
      ...generalQA.map((qa, i) => ({ id: `g:${i}`, group: "About you", text: qa.q.en })),
      ...topics.flatMap((t) => t.qa.map((qa, i) => ({ id: `t:${t.id}:${i}`, group: t.name, text: qa.q.en }))),
    ],
    [],
  );
  const mark = (qid: string) => (progress[qid]?.rating ? ["", "😅", "🙂", "😄"][progress[qid].rating!] : progress[qid]?.step ? "…" : "");
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="checklist-head">The real-interview set, in order</p>
      <div className="coach-picker">
        {REAL_SET.map((qid, i) => (
          <button key={qid} type="button" aria-pressed={id === qid} onClick={() => onPick(qid)}>
            <span className="coach-pick-n">{i + 1}</span>
            <span>{OPENING[i].q.en.replace(/[.?]$/, "")}</span>
            <span className="coach-pick-mark">{mark(qid)}</span>
          </button>
        ))}
      </div>
      <select value={REAL_SET.includes(id) ? "" : id} onChange={(e) => e.target.value && onPick(e.target.value)} aria-label="More questions">
        <option value="">More questions…</option>
        {[...new Set(others.map((o) => o.group))].map((g) => (
          <optgroup key={g} label={g}>
            {others
              .filter((o) => o.group === g)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {mark(o.id)} {o.text}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function Blanks({ q, fills, onFill }: { q: GameQuestion; fills: Record<string, string>; onFill: (blank: string, value: string) => void }) {
  const list = blanks(q);
  if (!list.length) return null;
  return (
    <details className="block blanks" open={list.some((b) => !fills[b]?.trim())}>
      <summary>Make it yours: fill in the 【】 parts ({list.filter((b) => fills[b]?.trim()).length}/{list.length})</summary>
      <p className="note" style={{ margin: "6px 0 10px" }}>
        Saved on this phone. The audio still reads the generic words, so say your own version aloud.
      </p>
      {list.map((b) => (
        <label key={b} className="blank">
          <span lang="ja">{b}</span>
          <input value={fills[b] ?? ""} onChange={(e) => onFill(b, e.target.value)} lang="ja" placeholder="あなたの言葉で" />
        </label>
      ))}
    </details>
  );
}

function PointLine({ line, n, big = false }: { line: Point; n: number; big?: boolean }) {
  return (
    <li className="coach-line">
      <span className="coach-n">{n}</span>
      <div className="line-body">
        <p className={`ja-line${big ? " coach-big" : ""}`}>
          <Ja text={line.ja} />
        </p>
        <p className="en-line">{line.en}</p>
      </div>
      <Speak text={line.say} size="sm" rate={SLOW} />
    </li>
  );
}

function ListenStep({ lines, onDone }: { lines: Point[]; onDone: () => void }) {
  const list = usePlaylist(
    lines.map((l) => l.say),
    SLOW,
  );
  return (
    <div className="block stack" style={{ gap: 10 }}>
      <PlayAll list={list} />
      <ol className="coach-list">
        {lines.map((l, i) => (
          <PointLine key={i} line={l} n={i + 1} />
        ))}
      </ol>
      <button type="button" className="btn btn-ink big" onClick={onDone}>
        I&apos;ve listened → Repeat
      </button>
    </div>
  );
}

function RepeatStep({ lines, onDone }: { lines: Point[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [said, setSaid] = useState(0);
  const line = lines[i];
  const last = i === lines.length - 1;
  return (
    <div className="block stack" style={{ gap: 12 }}>
      <p className="step-count">
        Point {i + 1} of {lines.length}
      </p>
      <div className="chunks">
        {chunks(line.ja).map((c, k) => (
          <p key={k} className="chunk ja-line">
            <Ja text={c} />
          </p>
        ))}
      </div>
      <p className="en-line">{line.en}</p>
      <div className="row wrap">
        <Speak text={line.say} size="lg" rate={SLOW} label="Play slowly" />
        <span className="note">Play, then say it. Breathe at each break.</span>
      </div>
      <div className="grade">
        <button type="button" className="btn" onClick={() => setSaid(said + 1)}>
          Said it {said > 0 ? `×${said}` : ""}
        </button>
        <button
          type="button"
          className="btn btn-ink"
          onClick={() => {
            stop();
            setSaid(0);
            if (last) onDone();
            else setI(i + 1);
          }}
        >
          {last ? "All points → Recall" : "Next point ›"}
        </button>
      </div>
      {said > 0 && <p className="cheer">{CHEERS[(i + said) % CHEERS.length]}</p>}
      {i > 0 && (
        <button type="button" className="link-btn" onClick={() => setI(i - 1)}>
          ‹ Previous point
        </button>
      )}
    </div>
  );
}

function RecallStep({ lines, onDone }: { lines: Point[]; onDone: () => void }) {
  // Points still to say; a missed point goes to the back for one more try.
  const [queue, setQueue] = useState(() => lines.map((_, i) => i));
  const [shown, setShown] = useState(false);
  const i = queue[0];
  const line = lines[i];
  const words = cues({ ja: line.say, en: line.en });

  function next(ok: boolean) {
    stop();
    setShown(false);
    const rest = queue.slice(1);
    const after = ok || rest.includes(i) ? rest : [...rest, i];
    if (after.length === 0) onDone();
    else setQueue(after);
  }

  return (
    <div className="block stack" style={{ gap: 12 }}>
      <p className="step-count">
        Point {i + 1} · {queue.length} to go
      </p>
      <div className="keywords recall-cues">
        {words.length ? (
          words.map((k) => (
            <span key={k} className="keyword">
              <Ja text={k} />
            </span>
          ))
        ) : (
          <span className="note">{line.en}</span>
        )}
      </div>
      {!shown ? (
        <button type="button" className="btn btn-ink big" onClick={() => setShown(true)}>
          I said it → Check
        </button>
      ) : (
        <>
          <ol className="coach-list">
            <PointLine line={line} n={i + 1} big />
          </ol>
          <div className="grade">
            <button type="button" className="btn again" onClick={() => next(false)}>
              Not quite
            </button>
            <button type="button" className="btn good" onClick={() => next(true)}>
              Close enough!
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SoloStep({
  lines,
  rating,
  onRate,
  onNext,
}: {
  lines: Point[];
  rating?: 1 | 2 | 3;
  onRate: (r: 1 | 2 | 3) => void;
  onNext: () => void;
}) {
  const [compare, setCompare] = useState(false);
  return (
    <div className="block stack" style={{ gap: 12 }}>
      <p className="note">Read the question above aloud to yourself, take a breath, then answer. Aim for about a minute.</p>
      <Recorder resetKey={lines.map((l) => l.say).join("")} />
      {!compare ? (
        <button type="button" className="btn btn-ink big" onClick={() => setCompare(true)}>
          Compare with the talking points
        </button>
      ) : (
        <>
          <ol className="coach-list">
            {lines.map((l, i) => (
              <PointLine key={i} line={l} n={i + 1} />
            ))}
          </ol>
          <p className="checklist-head">How did that feel?</p>
          <div className="faces">
            {(
              [
                [1, "😅", "Shaky"],
                [2, "🙂", "Getting there"],
                [3, "😄", "Clear!"],
              ] as const
            ).map(([r, face, label]) => (
              <button key={r} type="button" aria-pressed={rating === r} onClick={() => onRate(r)}>
                <span className="face">{face}</span>
                {label}
              </button>
            ))}
          </div>
          {rating && (
            <p className="cheer">
              {rating === 3 ? "素晴らしい！ On to the next one." : rating === 2 ? "Nearly there. One more Recall round helps." : "That's normal. Go back to Repeat once, then try again."}
            </p>
          )}
          <button type="button" className="btn big" onClick={onNext}>
            Next question ›
          </button>
        </>
      )}
    </div>
  );
}
