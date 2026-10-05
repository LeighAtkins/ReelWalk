"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { DeckCard } from "@/lib/content";
import type { Group } from "@/lib/types";
import { GROUP_ORDER, GROUPS } from "@/lib/groups";
import { speak } from "@/lib/speech";
import { useSettings } from "@/lib/settings";
import { useLocal } from "@/lib/store";
import { Ja } from "./Ja";
import { Speak } from "./Speak";

/** Leitner boxes: 0 new or missed, 3+ known. */
type Boxes = Record<string, number>;
const KNOWN = 3;

export function Flashcards({ deck, groupOf }: { deck: DeckCard[]; groupOf: Record<string, Group> }) {
  const params = useSearchParams();
  const [line, setLine] = useState<Group | "all">("all");
  const [direction, setDirection] = useLocal<"ja-en" | "en-ja">("cards-direction", "ja-en");
  const [boxes, setBoxes] = useLocal<Boxes>("cards", {});
  const [queue, setQueue] = useState<string[]>([]);
  const [flipped, setFlipped] = useState(false);
  const [s] = useSettings();

  useEffect(() => {
    const p = params.get("line") as Group | null;
    if (p && p in GROUPS) setLine(p);
  }, [params]);

  const cards = useMemo(() => deck.filter((c) => line === "all" || groupOf[c.topic] === line), [deck, line, groupOf]);
  const byKey = useMemo(() => new Map(cards.map((c) => [c.key, c])), [cards]);
  const known = cards.filter((c) => (boxes[c.key] ?? 0) >= KNOWN).length;

  // Build a round: weakest first, at most 20 cards.
  function newRound() {
    const order = [...cards].sort((a, b) => (boxes[a.key] ?? 0) - (boxes[b.key] ?? 0) || Math.random() - 0.5);
    setQueue(order.slice(0, 20).map((c) => c.key));
    setFlipped(false);
  }

  useEffect(() => {
    newRound();
    // A new round only when the line changes, not on every grade.
  }, [cards]);

  const card = queue.length ? byKey.get(queue[0]) : undefined;

  function grade(good: boolean) {
    if (!card) return;
    setBoxes((b) => ({ ...b, [card.key]: good ? (b[card.key] ?? 0) + 1 : 0 }));
    setQueue((q) => {
      const rest = q.slice(1);
      if (good) return rest;
      const at = Math.min(3, rest.length);
      return [...rest.slice(0, at), card.key, ...rest.slice(at)];
    });
    setFlipped(false);
  }

  function flip() {
    setFlipped(true);
    if (card && direction === "en-ja") speak(card.ja, { rate: s.rate, voiceURI: s.voiceURI });
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <select value={line} onChange={(e) => setLine(e.target.value as Group | "all")} aria-label="Which line">
          <option value="all">All lines ({deck.length} words)</option>
          {GROUP_ORDER.map((g) => (
            <option key={g} value={g}>
              {GROUPS[g].en}
            </option>
          ))}
        </select>
        <div className="seg">
          <button type="button" aria-pressed={direction === "ja-en"} onClick={() => setDirection("ja-en")}>
            日本語 › EN
          </button>
          <button type="button" aria-pressed={direction === "en-ja"} onClick={() => setDirection("en-ja")}>
            EN › 日本語
          </button>
        </div>
      </div>
      <div className="meter" aria-label={`${known} of ${cards.length} known`}>
        <span style={{ width: `${(known / Math.max(cards.length, 1)) * 100}%` }} />
      </div>
      <p className="note">
        {known} of {cards.length} known. {queue.length} left in this round.
      </p>

      {card ? (
        <>
          <div className="card" onClick={flip} role="button" tabIndex={0} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && flip()}>
            {direction === "ja-en" || flipped ? (
              <p className="card-ja">
                <Ja text={card.ja} />
              </p>
            ) : null}
            {direction === "en-ja" || flipped ? <p className="card-en">{card.en}</p> : null}
            {flipped && card.note && <p className="note">{card.note}</p>}
            {!flipped && <p className="card-hint">{direction === "ja-en" ? "Say the meaning, then tap" : "Say it in Japanese, then tap"}</p>}
            {(direction === "ja-en" || flipped) && (
              <div onClick={(e) => e.stopPropagation()}>
                <Speak text={card.ja} />
              </div>
            )}
          </div>
          {flipped ? (
            <div className="grade">
              <button type="button" className="btn again" onClick={() => grade(false)}>
                Missed it
              </button>
              <button type="button" className="btn good" onClick={() => grade(true)}>
                Knew it
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-ink" style={{ justifyContent: "center", minHeight: 52 }} onClick={flip}>
              Show answer
            </button>
          )}
        </>
      ) : (
        <div className="block stack" style={{ gap: 10 }}>
          <h2>Round finished</h2>
          <button type="button" className="btn btn-ink" onClick={newRound} style={{ alignSelf: "flex-start" }}>
            Start another round
          </button>
        </div>
      )}
    </div>
  );
}
