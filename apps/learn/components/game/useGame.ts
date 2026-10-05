"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { publish, subscribe, type Status } from "@/lib/game/relay";
import { initialState, type CandAction, type CandMsg, type GameState, type HostMsg, type RoundScore } from "@/lib/game/model";
import { readLocal, writeLocal } from "@/lib/store";

/**
 * The interviewer's phone owns the game: it keeps the state (also in
 * localStorage, so a reload resumes), applies the candidate's requests and
 * publishes every change. The candidate's phone only renders what it hears.
 */
export function useHostGame(room: string) {
  const key = `game-host-${room}`;
  const [state, setState] = useState<GameState>(initialState);
  const [scores, setScores] = useState<RoundScore[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(state);
  const scoresRef = useRef(scores);

  useEffect(() => {
    const saved = readLocal<{ state: GameState; scores: RoundScore[] } | null>(key, null);
    if (saved) {
      // Saved games from before a field existed get its default.
      const s = { ...initialState(), ...saved.state };
      ref.current = s;
      scoresRef.current = saved.scores;
      setState(s);
      setScores(saved.scores);
    }
  }, [key]);

  const send = useCallback(
    (msg: HostMsg) => publish(room, "host", msg).then(() => setError(null), () => setError("送信できませんでした。電波を確認してください。")),
    [room],
  );

  const commit = useCallback(
    (next: Omit<GameState, "seq">) => {
      const s = { ...next, seq: ref.current.seq + 1 };
      ref.current = s;
      setState(s);
      writeLocal(key, { state: s, scores: scoresRef.current });
      void send({ k: "state", s });
    },
    [key, send],
  );

  const update = useCallback((fn: (s: GameState) => Omit<GameState, "seq">) => commit(fn(ref.current)), [commit]);

  const addScore = useCallback(
    (r: RoundScore) => {
      const list = [...scoresRef.current.filter((x) => x.round !== r.round), r];
      scoresRef.current = list;
      setScores(list);
      writeLocal(key, { state: ref.current, scores: list });
      void send({ k: "score", r });
    },
    [key, send],
  );

  const resetScores = useCallback(() => {
    scoresRef.current = [];
    setScores([]);
  }, []);

  // Requests from the candidate.
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000) - 5;
    return subscribe<CandMsg>(
      room,
      now,
      ({ from, body }) => {
        if (from !== "cand" || body.k !== "intent") return;
        const s = ref.current;
        const sameRound = body.round === s.round;
        const live = s.phase === "asking" || s.phase === "answering";
        switch (body.a) {
          case "join":
            if (!s.joined) commit({ ...s, joined: true });
            else void send({ k: "state", s });
            break;
          case "done":
            if (s.phase === "answering" && sameRound)
              commit({ ...s, phase: "scoring", answerSeconds: s.answerStart ? Math.round((Date.now() - s.answerStart) / 1000) : 0 });
            break;
          case "repeat":
            if (live && sameRound) commit({ ...s, repeatPending: true, lifelines: { ...s.lifelines, repeats: s.lifelines.repeats + 1 } });
            break;
          case "hint":
            if (live && sameRound && !s.lifelines.hint) commit({ ...s, lifelines: { ...s.lifelines, hint: true } });
            break;
          case "text":
            if (live && sameRound && !s.lifelines.text) commit({ ...s, lifelines: { ...s.lifelines, text: true } });
            break;
          case "notes-full":
          case "notes-cue":
          case "notes-off": {
            const notes = body.a.slice(6) as GameState["notes"];
            if (s.notes !== notes) commit({ ...s, notes });
            break;
          }
        }
      },
      setStatus,
    );
  }, [room, commit, send]);

  const stampCount = useRef(0);
  const stamp = useCallback((id: string) => send({ k: "stamp", id, n: ++stampCount.current }), [send]);

  return { state, scores, status, error, update, addScore, resetScores, stamp };
}

export interface StampEvent {
  id: string;
  key: string;
}

/** The candidate's view: the newest state, every round's score, and live reactions. */
export function useCandidateGame(room: string | null) {
  const [state, setState] = useState<GameState | null>(null);
  const [scores, setScores] = useState<Record<number, RoundScore>>({});
  const [stamps, setStamps] = useState<StampEvent[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const nonce = useRef(0);
  const connectedAt = useRef(0);
  const roundRef = useRef(0);

  const act = useCallback(
    (a: CandAction) => {
      if (!room) return;
      publish(room, "cand", { k: "intent", a, round: roundRef.current, n: ++nonce.current } satisfies CandMsg).then(
        () => setError(null),
        () => setError("Couldn't reach the relay. Check your connection."),
      );
    },
    [room],
  );

  useEffect(() => {
    if (!room) return;
    connectedAt.current = Date.now();
    setState(null);
    setScores({});
    const unsub = subscribe<HostMsg>(
      room,
      "all",
      ({ from, body }) => {
        if (from !== "host") return;
        if (body.k === "state") {
          setState((prev) => {
            if (prev && prev.seq >= body.s.seq) return prev;
            roundRef.current = body.s.round;
            return body.s;
          });
        } else if (body.k === "score") {
          setScores((prev) => ({ ...prev, [body.r.round]: body.r }));
        } else if (body.k === "stamp" && Date.now() - connectedAt.current > 3000) {
          // Replayed history arrives in the first moments; only show reactions sent live.
          const ev = { id: body.id, key: `${body.n}-${Date.now()}` };
          setStamps((prev) => [...prev.slice(-4), ev]);
          setTimeout(() => setStamps((prev) => prev.filter((x) => x.key !== ev.key)), 4500);
        }
      },
      (s) => {
        setStatus(s);
        if (s === "live") act("join");
      },
    );
    return unsub;
  }, [room, act]);

  return { state, scores, stamps, status, error, act };
}

/** A short two-note chime and a buzz, so the candidate notices their turn without watching the screen. */
let ctx: AudioContext | null = null;
export function unlockChime() {
  ctx ??= new AudioContext();
  void ctx.resume();
}
export function chime(kind: "turn" | "score") {
  navigator.vibrate?.(kind === "turn" ? [120, 60, 120] : 80);
  if (!ctx) return;
  const notes = kind === "turn" ? [660, 990] : [880, 660, 1320];
  notes.forEach((f, i) => {
    const o = ctx!.createOscillator();
    const g = ctx!.createGain();
    o.frequency.value = f;
    o.type = "sine";
    const t = ctx!.currentTime + i * 0.14;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(ctx!.destination);
    o.start(t);
    o.stop(t + 0.32);
  });
}
