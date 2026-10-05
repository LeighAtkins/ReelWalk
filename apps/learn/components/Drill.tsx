"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DrillItem } from "@/lib/content";
import { speak, stop } from "@/lib/speech";
import { useSettings } from "@/lib/settings";
import { useLocal } from "@/lib/store";
import { Ja } from "./Ja";
import { LineList } from "./LineList";
import { Recorder } from "./Recorder";
import { Speak } from "./Speak";

type Grade = "good" | "again";

function shuffle<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function Drill({ items, names }: { items: DrillItem[]; names: Record<string, string> }) {
  const params = useSearchParams();
  const topic = params.get("topic");
  const [grades, setGrades] = useLocal<Record<string, Grade>>("drill", {});
  const [filter, setFilter] = useState<"todo" | "all">("todo");
  const [seed, setSeed] = useState(1);
  const [pos, setPos] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [thinking, setThinking] = useState(0);
  const [s] = useSettings();
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => setSeed(Math.floor(Math.random() * 100000)), []);

  const pool = useMemo(() => {
    const base = topic ? items.filter((i) => i.source === topic) : items;
    const list = filter === "todo" ? base.filter((i) => grades[i.key] !== "good") : base;
    return shuffle(list, seed);
  }, [items, topic, filter, seed]);

  const item = pool[pos % Math.max(pool.length, 1)];
  const doneCount = (topic ? items.filter((i) => i.source === topic) : items).filter((i) => grades[i.key] === "good").length;
  const total = topic ? items.filter((i) => i.source === topic).length : items.length;

  useEffect(() => {
    if (tick.current) clearInterval(tick.current);
    setThinking(0);
    tick.current = setInterval(() => setThinking((t) => t + 1), 1000);
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, [item?.key]);

  useEffect(() => () => stop(), []);

  function next(grade?: Grade) {
    if (grade && item) setGrades((g) => ({ ...g, [item.key]: grade }));
    setRevealed(false);
    setPos((p) => p + 1);
    stop();
  }

  function playQuestion() {
    if (item) speak(item.q.ja, { rate: s.rate, voiceURI: s.voiceURI });
  }

  if (!item) {
    return (
      <div className="block stack" style={{ gap: 12 }}>
        <h2>Every question here is marked as said well.</h2>
        <button type="button" className="btn" onClick={() => setFilter("all")}>
          Drill them all again
        </button>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <div className="seg">
          <button type="button" aria-pressed={filter === "todo"} onClick={() => { setFilter("todo"); setPos(0); }}>
            Not yet solid
          </button>
          <button type="button" aria-pressed={filter === "all"} onClick={() => { setFilter("all"); setPos(0); }}>
            All
          </button>
        </div>
        {topic && (
          <Link href="/drill/" className="note">
            {names[topic] ?? topic} only · show all
          </Link>
        )}
      </div>
      <div className="meter" aria-label={`${doneCount} of ${total} said well`}>
        <span style={{ width: `${(doneCount / Math.max(total, 1)) * 100}%` }} />
      </div>
      <p className="note">
        {doneCount} of {total} said well. Question {(pos % pool.length) + 1} of {pool.length} in this round.
      </p>

      <div className="drill-q">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="note" style={{ color: "#b7c0cb" }}>
            {item.source === "general" ? "General" : names[item.source] ?? item.source}
          </span>
          <span className="timer" aria-label="Thinking time">
            {Math.floor(thinking / 60)}:{String(thinking % 60).padStart(2, "0")}
          </span>
        </div>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <Speak text={item.q.ja} size="lg" label="Play the question" />
          <div>
            <p className="qa-q">
              <Ja text={item.q.ja} />
            </p>
            <p className="qa-qen en-line">{item.q.en}</p>
          </div>
        </div>
      </div>

      <div className="block stack" style={{ gap: 10 }}>
        <p className="note">Answer out loud first. Record it if you want to hear yourself back.</p>
        <Recorder resetKey={item.key} />
      </div>

      {revealed ? (
        <div className="block">
          <h3 style={{ marginBottom: 8 }}>Model answer</h3>
          <LineList lines={item.a} />
          {item.tip && <p className="tip">{item.tip}</p>}
        </div>
      ) : (
        <button type="button" className="btn btn-ink" style={{ justifyContent: "center", minHeight: 52 }} onClick={() => setRevealed(true)}>
          Show the model answer
        </button>
      )}

      <div className="grade">
        <button type="button" className="btn again" onClick={() => next("again")}>
          Needs work
        </button>
        <button type="button" className="btn good" onClick={() => next("good")}>
          Said it well
        </button>
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button type="button" className="btn" onClick={playQuestion}>
          Hear the question again
        </button>
        <button type="button" className="btn" onClick={() => next()}>
          Skip
        </button>
      </div>
    </div>
  );
}
