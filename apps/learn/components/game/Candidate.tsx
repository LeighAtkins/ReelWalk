"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { COSTS, RATINGS, REPEAT_PHRASE, STAMPS } from "@/content/game";
import { OPENER } from "@/content/misc";
import { cues, keywords, question, titleFor, type GameQuestion, type GameState, type Notes, type RoundScore } from "@/lib/game/model";
import { normaliseCode } from "@/lib/game/relay";
import { useLocal } from "@/lib/store";
import { Ja } from "../Ja";
import { Recorder } from "../Recorder";
import { Speak } from "../Speak";
import { Elapsed, RelayDot, Stars, TurnBanner } from "./Bits";
import { chime, unlockChime, useCandidateGame, type StampEvent } from "./useGame";

export function Candidate() {
  const params = useSearchParams();
  const [saved, setSaved] = useLocal<string>("game-join", "");
  const [code, setCode] = useState("");
  const [room, setRoom] = useState<string | null>(null);

  useEffect(() => {
    setCode(normaliseCode(params.get("room") ?? saved));
  }, [params, saved]);

  if (!room) {
    return (
      <div className="game cand">
        <header className="game-head">
          <span className="game-title">Mock interview: candidate</span>
        </header>
        <section className="stack">
          <div className="room-card">
            <p className="room-label">Room code from the interviewer's phone</p>
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(normaliseCode(e.target.value))}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="ABC123"
              aria-label="Room code"
            />
            <button
              type="button"
              className="btn btn-ink big"
              disabled={code.length !== 6}
              onClick={() => {
                unlockChime();
                setSaved(code);
                setRoom(code);
              }}
            >
              Join the interview
            </button>
          </div>
          <p className="note">
            Your phone chimes and buzzes when it's your turn. Questions aren't shown: listen to the interviewer, like the real thing.
          </p>
        </section>
      </div>
    );
  }
  return <CandidateGame room={room} onLeave={() => setRoom(null)} />;
}

function CandidateGame({ room, onLeave }: { room: string; onLeave: () => void }) {
  const { state, scores, stamps, status, error, act } = useCandidateGame(room);
  const prev = useRef<string>("");
  const [repeatShown, setRepeatShown] = useState(false);
  const [notes, setNotes] = useLocal<Notes>("game-notes", "full");

  // The interviewer's phone shows which notes are on; keep it in step with ours.
  useEffect(() => {
    if (state && state.notes !== notes) act(`notes-${notes}`);
  }, [state, notes, act]);

  // Chime when the turn comes to us, and when a score arrives.
  useEffect(() => {
    if (!state) return;
    const sig = `${state.round}:${state.phase}`;
    if (prev.current && prev.current !== sig) {
      if (state.phase === "answering") chime("turn");
      if (state.phase === "result" || state.phase === "final") chime("score");
    }
    prev.current = sig;
  }, [state]);

  useEffect(() => setRepeatShown(false), [state?.round]);

  return (
    <div className="game cand">
      <header className="game-head">
        <span className="game-title">Room {room}</span>
        <RelayDot status={status} />
      </header>
      {error && <p className="game-error">{error}</p>}
      <StampLayer stamps={stamps} />

      {state && state.phase !== "final" && <NotesSwitch notes={notes} onChange={setNotes} />}

      {!state ? (
        <section className="stack">
          <p className="lede">Connecting to the interviewer's phone… If this stays, check the code with them.</p>
          <button type="button" className="link-btn" onClick={onLeave}>
            Change the room code
          </button>
        </section>
      ) : state.phase === "lobby" ? (
        <Lobby />
      ) : state.phase === "final" ? (
        <Final scores={Object.values(scores)} />
      ) : (
        <Round state={state} notes={notes} score={scores[state.round]} act={act} repeatShown={repeatShown} onRepeat={() => setRepeatShown(true)} />
      )}
    </div>
  );
}

function Lobby() {
  return (
    <section className="stack">
      <TurnBanner who="them" ja="準備中" sub="Waiting for the interviewer to start" />
      <div className="block stack" style={{ gap: 10 }}>
        <h2>Warm up while you wait</h2>
        <p className="note">Your first line when the interview starts:</p>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <Speak text={OPENER.ja} />
          <p className="ja-line">
            <Ja text={OPENER.ja} />
          </p>
        </div>
        <p className="note">
          Lifelines: ask for a repeat (free, but say the phrase out loud), see keywords (−{COSTS.hint}), or read the question (−{COSTS.text}). The interviewer
          sees when you use one.
        </p>
      </div>
    </section>
  );
}

function NotesSwitch({ notes, onChange }: { notes: Notes; onChange: (n: Notes) => void }) {
  return (
    <div className="notes-switch" role="group" aria-label="Notes on your screen">
      <span className="note">My notes</span>
      <div className="seg">
        {(
          [
            ["full", "Full answer"],
            ["cue", "Cue words"],
            ["off", "None (real)"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={notes === id} onClick={() => onChange(id)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The talking points for this question, as full lines or just cue words. */
function TalkingPoints({ q, notes }: { q: GameQuestion; notes: Exclude<Notes, "off"> }) {
  // The learner's own words for the 【】 blanks, typed in the coach.
  const [fills] = useLocal<Record<string, string>>("coach-fills", {});
  const mine = (ja: string) => ja.replace(/【[^】]+】/g, (b) => (fills[b]?.trim() ? `【${fills[b].trim()}】` : b));
  return (
    <div className="notes-card">
      <p className="checklist-head">{notes === "full" ? "Your talking points: say them slowly, one at a time" : "Cue words for each point"}</p>
      <ol className="notes-list">
        {q.a.map((l, i) => (
          <li key={i}>
            {notes === "full" ? (
              <>
                <Speak text={l.ja} size="sm" />
                <span className="ja-line">
                  <Ja text={mine(l.ja)} />
                </span>
              </>
            ) : (
              <span className="keywords">
                {cues(l).map((k) => (
                  <span key={k} className="keyword">
                    <Ja text={k} />
                  </span>
                ))}
                {cues(l).length === 0 && <span className="note">{l.en}</span>}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Round({
  state,
  notes,
  score,
  act,
  repeatShown,
  onRepeat,
}: {
  state: GameState;
  notes: Notes;
  score?: RoundScore;
  act: ReturnType<typeof useCandidateGame>["act"];
  repeatShown: boolean;
  onRepeat: () => void;
}) {
  const qid = state.order[state.round];
  const q = qid ? question(qid) : undefined;
  if (!q) return null;
  const live = state.phase === "asking" || state.phase === "answering";
  const reveal = state.phase === "result";

  return (
    <section className="stack">
      <p className="round-count">
        Question {state.round + 1} of {state.order.length}
      </p>

      {state.phase === "asking" && <TurnBanner who="them" ja="面接官の番" sub="Listen to the question" />}
      {state.phase === "answering" && <TurnBanner who="you" ja="あなたの番" sub="Answer out loud, in Japanese" />}
      {state.phase === "scoring" && <TurnBanner who="them" ja="採点中" sub="The interviewer is scoring your answer" />}
      {state.phase === "result" && score && <TurnBanner who="both" ja={`${score.points}点`} sub={`out of ${score.max}`} />}

      {state.phase === "answering" && (
        <div className="answer-clock">
          <Elapsed since={state.answerStart} />
          <span className="note">About a minute is a good length.</span>
        </div>
      )}

      {(state.lifelines.text || reveal || (notes !== "off" && live)) && (
        <div className="question-card">
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Speak text={q.q.ja} size="sm" />
            <p className="question-text">
              <Ja text={q.q.ja} />
            </p>
          </div>
          <p className="note">{q.q.en}</p>
        </div>
      )}

      {notes !== "off" && live && <TalkingPoints q={q} notes={notes} />}

      {state.lifelines.hint && notes === "off" && !reveal && (
        <div className="hint-card">
          <p className="checklist-head">Keywords to work in</p>
          <div className="keywords">
            {keywords(q).map((k) => (
              <span key={k} className="keyword">
                <Ja text={k} />
              </span>
            ))}
          </div>
        </div>
      )}

      {repeatShown && live && (
        <div className="say-card">
          <p className="checklist-head">Say this out loud</p>
          <p className="ja-line">
            <Ja text={REPEAT_PHRASE.ja} />
          </p>
        </div>
      )}

      {live && (
        <div className="lifelines">
          <button
            type="button"
            className="btn"
            onClick={() => {
              onRepeat();
              act("repeat");
            }}
          >
            🔁 Ask to repeat
          </button>
          {notes === "off" && (
            <>
              <button type="button" className="btn" disabled={state.lifelines.hint} onClick={() => act("hint")}>
                🔑 Keywords −{COSTS.hint}
              </button>
              <button type="button" className="btn" disabled={state.lifelines.text} onClick={() => act("text")}>
                📄 Read question −{COSTS.text}
              </button>
            </>
          )}
        </div>
      )}

      <div className="block stack" style={{ gap: 8, display: state.phase === "asking" ? "none" : undefined }}>
        <p className="note">Record your answer to hear it back after scoring (stays on this phone).</p>
        <Recorder resetKey={`${state.round}-${qid}`} />
      </div>

      {state.phase === "answering" && (
        <button type="button" className="btn btn-ink big" onClick={() => act("done")}>
          I&apos;ve finished my answer
        </button>
      )}

      {reveal && score && <ScoreCard q={q} score={score} />}
      {reveal && <p className="note center">Waiting for the next question…</p>}
    </section>
  );
}

function ScoreCard({ q, score }: { q: NonNullable<ReturnType<typeof question>>; score: RoundScore }) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="block score-card">
        {RATINGS.map((r) => (
          <div key={r.id} className="score-row">
            <span>
              <span lang="ja">{r.ja}</span> <span className="note">{r.en}</span>
            </span>
            <Stars n={score[r.id]} />
          </div>
        ))}
        <div className="score-row">
          <span>Points mentioned</span>
          <strong>
            {score.ticks.length} / {q.a.length}
          </strong>
        </div>
        {score.penalty > 0 && (
          <div className="score-row">
            <span>Lifelines</span>
            <strong>−{score.penalty}</strong>
          </div>
        )}
        <div className="score-row">
          <span>Answer length</span>
          <strong>{score.seconds}s</strong>
        </div>
        {score.comment && (
          <p className="interviewer-comment" lang="ja">
            「{score.comment}」
          </p>
        )}
      </div>
      <div className="block">
        <h3 style={{ marginBottom: 6 }}>Model answer</h3>
        <ol className="model">
          {q.a.map((l, i) => (
            <li key={i} data-hit={score.ticks.includes(i) || undefined}>
              <span className="model-mark" aria-label={score.ticks.includes(i) ? "You said this" : "Missed"}>
                {score.ticks.includes(i) ? "✓" : "○"}
              </span>
              <Speak text={l.ja} size="sm" />
              <span className="line-body">
                <span className="ja-line">
                  <Ja text={l.ja} />
                </span>
                <span className="en-line">{l.en}</span>
              </span>
            </li>
          ))}
        </ol>
        {q.tip && <p className="tip">{q.tip}</p>}
      </div>
    </div>
  );
}

function Final({ scores }: { scores: RoundScore[] }) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const sorted = [...scores].sort((a, b) => a.round - b.round);
  const points = sorted.reduce((n, s) => n + s.points, 0);
  const max = sorted.reduce((n, s) => n + s.max, 0);
  const title = titleFor(points, max);
  return (
    <section className="stack final">
      <p className="final-emoji">{title.emoji}</p>
      <h1 className="final-title" lang="ja">
        {title.ja}
      </h1>
      <p className="note center">{title.en}</p>
      <p className="final-score">
        {points}
        <span> / {max}</span>
      </p>
      <a className="btn btn-ink big" href={`${base}/coach/`}>
        Practise these answers in the coach
      </a>
      <div className="stack" style={{ gap: 8 }}>
        {sorted.map((s) => {
          const q = question(s.qid);
          return q ? (
            <details key={s.round} className="block review">
              <summary>
                <span className="ja-line" style={{ fontSize: 16 }}>
                  <Ja text={q.q.ja} />
                </span>
                <strong>{s.points}</strong>
              </summary>
              <ScoreCard q={q} score={s} />
            </details>
          ) : null;
        })}
      </div>
    </section>
  );
}

function StampLayer({ stamps }: { stamps: StampEvent[] }) {
  return (
    <div className="stamp-layer" aria-live="polite">
      {stamps.map((s, i) => {
        const st = STAMPS.find((x) => x.id === s.id);
        return st ? (
          <div key={s.key} className="stamp-pop" style={{ left: `${12 + ((i * 37) % 60)}%` }}>
            <span className="stamp-emoji">{st.emoji}</span>
            <span lang="ja">{st.ja}</span>
            <span className="stamp-en">{st.en}</span>
          </div>
        ) : null;
      })}
    </div>
  );
}
