import { generalQA, topicById, topics } from "@/lib/content";
import { COSTS, OPENING, TITLES } from "@/content/game";
import { parseRuby } from "@/lib/ruby";
import type { Line } from "@/lib/types";

export type Phase = "lobby" | "asking" | "answering" | "scoring" | "result" | "final";
export type Mode = "full" | "tech" | "general";

/** Everything both phones need, published by the interviewer after each change. */
export interface GameState {
  seq: number;
  phase: Phase;
  mode: Mode;
  order: string[];
  round: number;
  joined: boolean;
  /** When the candidate started answering (ms since epoch). */
  answerStart: number | null;
  answerSeconds: number;
  lifelines: { repeats: number; hint: boolean; text: boolean };
  /** The candidate asked for a repeat and the interviewer hasn't acknowledged it. */
  repeatPending: boolean;
}

export interface RoundScore {
  round: number;
  qid: string;
  content: number;
  japanese: number;
  delivery: number;
  ticks: number[];
  penalty: number;
  points: number;
  max: number;
  seconds: number;
  comment: string;
}

export type HostMsg = { k: "state"; s: GameState } | { k: "score"; r: RoundScore } | { k: "stamp"; id: string; n: number };
export type CandAction = "join" | "done" | "repeat" | "hint" | "text";
export type CandMsg = { k: "intent"; a: CandAction; round: number; n: number };

export const initialState = (): GameState => ({
  seq: 0,
  phase: "lobby",
  mode: "full",
  order: [],
  round: 0,
  joined: false,
  answerStart: null,
  answerSeconds: 0,
  lifelines: { repeats: 0, hint: false, text: false },
  repeatPending: false,
});

export interface GameQuestion {
  id: string;
  /** Short label for the category. */
  label: { ja: string; en: string };
  q: Line;
  a: Line[];
  /** Guidance for the interviewer, in Japanese. */
  note?: string;
  /** English tip from the lesson, for the candidate's review. */
  tip?: string;
}

export function question(id: string): GameQuestion | undefined {
  const [kind, a, b] = id.split(":");
  if (kind === "o") {
    const o = OPENING.find((x) => x.id === a);
    return o && { id, label: { ja: "定番", en: "Standard" }, q: o.q, a: o.a, note: o.note };
  }
  if (kind === "g") {
    const qa = generalQA[Number(a)];
    return qa && { id, label: { ja: "人物・経験", en: "About you" }, q: qa.q, a: qa.a, tip: qa.tip };
  }
  if (kind === "t") {
    const t = topicById(a);
    const qa = t?.qa[Number(b)];
    return t && qa ? { id, label: { ja: `技術：${t.name}`, en: t.name }, q: qa.q, a: qa.a, tip: qa.tip } : undefined;
  }
  return undefined;
}

const techIds = () => topics.flatMap((t) => t.qa.map((_, i) => `t:${t.id}:${i}`));
const generalIds = () => generalQA.map((_, i) => `g:${i}`);

function shuffle<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9;
    s >>>= 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Questions the interviewer can swap in for the current one. */
export function swapPool(mode: Mode): string[] {
  if (mode === "tech") return techIds();
  if (mode === "general") return [...generalIds(), "o:stack"];
  return [...techIds(), ...generalIds(), "o:stack"];
}

/** The questions for a game. "full" runs like a real first interview. */
export function buildOrder(mode: Mode, length: number, seed: number): string[] {
  if (mode === "tech") return shuffle(techIds(), seed).slice(0, length);
  if (mode === "general") return shuffle([...generalIds(), "o:stack", "o:motivation"], seed).slice(0, length);
  const start = ["o:intro", "o:reelwalk", "o:motivation"];
  const end = ["o:aws", "o:ask", "o:closing"];
  const middleCount = Math.max(0, length - start.length - end.length);
  const tech = shuffle(techIds(), seed);
  const general = shuffle(["o:stack", ...generalIds()], seed + 1);
  const middle: string[] = [];
  for (let i = 0; middle.length < middleCount; i++) middle.push(i % 2 === 0 ? tech[i >> 1] : general[i >> 1]);
  return [...start, ...middle, ...end].slice(0, Math.max(length, 1));
}

/**
 * Words worth working in, for the hint lifeline: annotated terms and product
 * names from the model answer first, then other kanji compounds. Single-kanji
 * annotations are skipped; they are verb stems (申し, 携わる), not keywords.
 */
export function keywords(q: GameQuestion, max = 6): string[] {
  const strong: string[] = [];
  const weak: string[] = [];
  const seen = new Set<string>();
  const add = (list: string[], markup: string, plain: string) => {
    if (seen.has(plain)) return;
    seen.add(plain);
    list.push(markup);
  };
  for (const line of q.a) {
    for (const t of parseRuby(line.ja)) {
      if (t.kind === "ruby") {
        if (t.latin) add(strong, t.base, t.base);
        else if (t.base.length >= 2) add(strong, `${t.base}{${t.reading}}`, t.base);
      } else {
        if (t.text.includes("【")) continue;
        for (const m of t.text.match(/[A-Z][A-Za-z0-9.]{2,}(?: [A-Z][A-Za-z]+)?/g) ?? []) add(strong, m, m);
        for (const m of t.text.match(/[一-鿿]{2,}/g) ?? []) add(weak, m, m);
      }
    }
  }
  return [...strong, ...weak.sort((x, y) => y.length - x.length)].slice(0, max);
}

export function penaltyFor(l: GameState["lifelines"]): number {
  return (l.hint ? COSTS.hint : 0) + (l.text ? COSTS.text : 0) + l.repeats * COSTS.repeat;
}

export function scoreRound(input: Omit<RoundScore, "points" | "max">, answerLines: number): RoundScore {
  const base = (input.content + input.japanese + input.delivery) * 2 + input.ticks.length;
  return { ...input, points: Math.max(0, base - input.penalty), max: 30 + answerLines };
}

export function titleFor(points: number, max: number) {
  const share = max ? points / max : 0;
  return TITLES.find((t) => share >= t.min) ?? TITLES[TITLES.length - 1];
}
