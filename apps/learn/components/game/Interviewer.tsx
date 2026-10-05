"use client";

import { useEffect, useMemo, useState } from "react";
import { FOLLOW_UPS, RATINGS, STAMPS } from "@/content/game";
import { buildOrder, penaltyFor, question, scoreRound, swapPool, titleFor, type Mode, type RoundScore } from "@/lib/game/model";
import { newRoomCode } from "@/lib/game/relay";
import { toPlain } from "@/lib/ruby";
import { useLocal } from "@/lib/store";
import { useHostGame } from "./useGame";
import { Elapsed, RelayDot, TurnBanner } from "./Bits";

const MODES: { id: Mode; ja: string; sub: string }[] = [
  { id: "full", ja: "本番モード", sub: "自己紹介から逆質問まで、一次面接の流れ" },
  { id: "tech", ja: "技術の深掘り", sub: "ReelWalkの技術についての質問だけ" },
  { id: "general", ja: "人物・経験", sub: "強み、チーム、志望動機など" },
];

export function Interviewer() {
  const [room, setRoom, loaded] = useLocal<string | null>("game-room", null);
  useEffect(() => {
    if (loaded && !room) setRoom(newRoomCode());
  }, [loaded, room, setRoom]);
  if (!room) return null;
  return <HostGame key={room} room={room} onNewRoom={() => setRoom(newRoomCode())} />;
}

function HostGame({ room, onNewRoom }: { room: string; onNewRoom: () => void }) {
  const g = useHostGame(room);
  const { state } = g;
  const [mode, setMode] = useState<Mode>("full");
  const [length, setLength] = useState(10);
  const [ticks, setTicks] = useState<number[]>([]);
  const [rating, setRating] = useState<Record<string, number>>({});
  const [comment, setComment] = useState("");
  const [showFollow, setShowFollow] = useState(false);

  const qid = state.order[state.round];
  const q = qid ? question(qid) : undefined;
  const total = state.order.length;
  const last = state.round >= total - 1;

  // Each round starts with a clean score sheet.
  useEffect(() => {
    setTicks([]);
    setRating({});
    setComment("");
    setShowFollow(false);
  }, [state.round, qid]);

  function start() {
    g.resetScores();
    g.update((s) => ({
      ...s,
      phase: "asking",
      mode,
      order: buildOrder(mode, length, Math.floor(Math.random() * 1e9)),
      round: 0,
      answerStart: null,
      answerSeconds: 0,
      lifelines: { repeats: 0, hint: false, text: false },
      repeatPending: false,
    }));
  }

  function swapQuestion() {
    const pool = swapPool(state.mode).filter((id) => !state.order.includes(id));
    if (!pool.length) return;
    const next = pool[Math.floor(Math.random() * pool.length)];
    g.update((s) => ({ ...s, order: s.order.map((id, i) => (i === s.round ? next : id)), lifelines: { repeats: 0, hint: false, text: false } }));
  }

  function submitScore() {
    if (!q) return;
    g.addScore(
      scoreRound(
        {
          round: state.round,
          qid,
          content: rating.content ?? 3,
          japanese: rating.japanese ?? 3,
          delivery: rating.delivery ?? 3,
          ticks,
          penalty: penaltyFor(state.lifelines),
          seconds: state.answerSeconds,
          comment: comment.trim().slice(0, 120),
        },
        q.a.length,
      ),
    );
    g.update((s) => ({ ...s, phase: "result" }));
  }

  function next() {
    if (last) return g.update((s) => ({ ...s, phase: "final" }));
    g.update((s) => ({
      ...s,
      phase: "asking",
      round: s.round + 1,
      answerStart: null,
      answerSeconds: 0,
      lifelines: { repeats: 0, hint: false, text: false },
      repeatPending: false,
    }));
  }

  const link = useMemo(() => {
    if (typeof window === "undefined") return "";
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    return `${window.location.origin}${base}/game/candidate/?room=${room}`;
  }, [room]);

  const myScore = g.scores.find((s) => s.round === state.round);

  return (
    <div className="game host" lang="ja">
      <header className="game-head">
        <span className="game-title">模擬面接ゲーム・面接官</span>
        <RelayDot status={g.status} ja />
      </header>
      {g.error && <p className="game-error">{g.error}</p>}

      {state.phase === "lobby" && (
        <section className="stack">
          <div className="room-card">
            <p className="room-label">ルームコード</p>
            <p className="room-code">{room}</p>
            <p className="note">応募者のスマホで、このリンクを開いてもらってください。</p>
            <div className="row wrap" style={{ justifyContent: "center" }}>
              <button
                type="button"
                className="btn"
                onClick={() => (navigator.share ? navigator.share({ title: "模擬面接", url: link }).catch(() => {}) : navigator.clipboard?.writeText(link))}
              >
                リンクを送る
              </button>
            </div>
            <p className={`join-state${state.joined ? " on" : ""}`}>{state.joined ? "応募者が入室しました ✓" : "応募者の入室を待っています…"}</p>
          </div>

          <div className="block stack" style={{ gap: 10 }}>
            <h2>面接の種類</h2>
            <div className="choice-list">
              {MODES.map((m) => (
                <button key={m.id} type="button" className="choice" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
                  <strong>{m.ja}</strong>
                  <span>{m.sub}</span>
                </button>
              ))}
            </div>
            <h2 style={{ marginTop: 6 }}>質問の数</h2>
            <div className="seg">
              {[6, 10, 14].map((n) => (
                <button key={n} type="button" aria-pressed={length === n} onClick={() => setLength(n)}>
                  {n}問{n === 6 ? "（約20分）" : n === 10 ? "（約35分）" : "（約50分）"}
                </button>
              ))}
            </div>
          </div>

          <div className="block">
            <h2>遊び方</h2>
            <ol className="howto">
              <li>あなたの画面に質問が出ます。声に出して読んでください。</li>
              <li>応募者が日本語で答えます。言えたポイントにチェックを付け、スタンプで反応できます。</li>
              <li>回答が終わったら、内容・日本語・伝え方を5段階で採点します。</li>
              <li>応募者の画面には、点数とコメントと模範解答が出ます。</li>
            </ol>
            <p className="note">応募者は「もう一度」「キーワード」「質問文を見る」を使えます。使うと、あなたの画面に表示されます。</p>
            <p className="note">
              応募者は、模範解答のメモを見ながら練習することもできます（全文・キーワードだけ・なし）。今は「{{ full: "全文", cue: "キーワードだけ", off: "なし" }[state.notes]}」です。
            </p>
          </div>

          <button type="button" className="btn btn-ink big" onClick={start}>
            面接を始める
          </button>
          <button type="button" className="link-btn" onClick={onNewRoom}>
            新しい部屋を作る
          </button>
        </section>
      )}

      {q && state.phase !== "lobby" && state.phase !== "final" && (
        <section className="stack">
          <p className="round-count">
            第{state.round + 1}問 / 全{total}問 <span className="tag">{q.label.ja}</span>
          </p>

          {state.phase === "asking" && <TurnBanner who="you" ja="あなたの番" sub="質問を読み上げてください" />}
          {state.phase === "answering" && <TurnBanner who="them" ja="応募者の番" sub="回答を聞いてください" />}
          {state.phase === "scoring" && <TurnBanner who="you" ja="あなたの番" sub="採点してください" />}
          {state.phase === "result" && <TurnBanner who="both" ja="結果" sub={`${myScore?.points ?? 0}点 / ${myScore?.max ?? 0}点`} />}

          {state.repeatPending && (
            <div className="alert">
              <span>応募者：「もう一度おっしゃっていただけますか」</span>
              <button type="button" className="btn" onClick={() => g.update((s) => ({ ...s, repeatPending: false }))}>
                もう一度読みました
              </button>
            </div>
          )}

          <div className="question-card">
            <p className="question-text">{toPlain(q.q.ja)}</p>
            {q.note && <p className="question-note">見るポイント：{q.note}</p>}
            <p className="notes-flag" data-notes={state.notes}>
              応募者のメモ：{{ full: "模範解答を見ながら練習中", cue: "キーワードだけ見ています", off: "メモなし（本番と同じ）" }[state.notes]}
            </p>
            <LifelineFlags l={state.lifelines} />
          </div>

          {state.phase === "asking" && (
            <>
              <button
                type="button"
                className="btn btn-ink big"
                onClick={() => g.update((s) => ({ ...s, phase: "answering", answerStart: Date.now(), repeatPending: false }))}
              >
                読み上げました → 回答スタート
              </button>
              <button type="button" className="link-btn" onClick={swapQuestion}>
                別の質問に替える
              </button>
            </>
          )}

          {state.phase === "answering" && (
            <>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="note">回答時間</span>
                <Elapsed since={state.answerStart} />
              </div>
              <div className="stamps">
                {STAMPS.map((st) => (
                  <button key={st.id} type="button" className="stamp-btn" onClick={() => g.stamp(st.id)}>
                    <span className="stamp-emoji">{st.emoji}</span>
                    {st.ja}
                  </button>
                ))}
              </div>
              <Checklist lines={q.a.map((l) => toPlain(l.ja))} ticks={ticks} onToggle={(i) => setTicks((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))} />
              <button type="button" className="link-btn" onClick={() => setShowFollow(!showFollow)}>
                {showFollow ? "深掘りの質問を隠す" : "深掘りの質問を見る"}
              </button>
              {showFollow && (
                <ul className="follow">
                  {FOLLOW_UPS.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="btn btn-ink big"
                onClick={() =>
                  g.update((s) => ({ ...s, phase: "scoring", answerSeconds: s.answerStart ? Math.round((Date.now() - s.answerStart) / 1000) : 0 }))
                }
              >
                回答終了 → 採点へ
              </button>
            </>
          )}

          {state.phase === "scoring" && (
            <>
              <p className="note">回答時間：{state.answerSeconds}秒</p>
              {RATINGS.map((r) => (
                <div key={r.id} className="rating">
                  <div>
                    <strong>{r.ja}</strong>
                    <span className="note"> {r.hint}</span>
                  </div>
                  <div className="rating-row">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} type="button" aria-pressed={(rating[r.id] ?? 0) >= n} onClick={() => setRating((prev) => ({ ...prev, [r.id]: n }))}>
                        ★
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <Checklist lines={q.a.map((l) => toPlain(l.ja))} ticks={ticks} onToggle={(i) => setTicks((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))} />
              <label className="comment">
                <span>ひとことコメント（任意）</span>
                <textarea value={comment} maxLength={120} rows={3} onChange={(e) => setComment(e.target.value)} placeholder="例：敬語が自然でした。結論を先に言うと、もっと良いです。" />
              </label>
              <p className="note">
                未入力の項目は★3で計算します。ライフライン：−{penaltyFor(state.lifelines)}点
              </p>
              <button type="button" className="btn btn-ink big" onClick={submitScore}>
                採点を送る
              </button>
            </>
          )}

          {state.phase === "result" && (
            <button type="button" className="btn btn-ink big" onClick={next}>
              {last ? "結果発表へ" : "次の質問へ"}
            </button>
          )}
        </section>
      )}

      {state.phase === "final" && <HostFinal scores={g.scores} onAgain={() => g.update((s) => ({ ...s, phase: "lobby" }))} />}
    </div>
  );
}

function LifelineFlags({ l }: { l: { repeats: number; hint: boolean; text: boolean } }) {
  const used = [l.repeats ? `もう一度×${l.repeats}` : null, l.hint ? "キーワードを見た" : null, l.text ? "質問文を見た" : null].filter(Boolean);
  if (!used.length) return null;
  return <p className="lifeline-flags">応募者のライフライン：{used.join("、")}</p>;
}

function Checklist({ lines, ticks, onToggle }: { lines: string[]; ticks: number[]; onToggle: (i: number) => void }) {
  return (
    <div className="checklist">
      <p className="checklist-head">模範解答のポイント（言えたらチェック）</p>
      {lines.map((l, i) => (
        <label key={i} className="check-line" data-on={ticks.includes(i) || undefined}>
          <input type="checkbox" checked={ticks.includes(i)} onChange={() => onToggle(i)} />
          <span>{l}</span>
        </label>
      ))}
    </div>
  );
}

function HostFinal({ scores, onAgain }: { scores: RoundScore[]; onAgain: () => void }) {
  const points = scores.reduce((n, s) => n + s.points, 0);
  const max = scores.reduce((n, s) => n + s.max, 0);
  const title = titleFor(points, max);
  return (
    <section className="stack final">
      <p className="final-emoji">{title.emoji}</p>
      <h1 className="final-title">{title.ja}</h1>
      <p className="final-score">
        {points}
        <span> / {max}点</span>
      </p>
      <ol className="final-list">
        {[...scores]
          .sort((a, b) => a.round - b.round)
          .map((s) => (
            <li key={s.round}>
              <span>{toPlain(question(s.qid)?.q.ja ?? "")}</span>
              <strong>{s.points}点</strong>
            </li>
          ))}
      </ol>
      <button type="button" className="btn btn-ink big" onClick={onAgain}>
        もう一度遊ぶ
      </button>
    </section>
  );
}
