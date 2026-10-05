import type { Line } from "../lib/types";
import { company, scripts } from "./interview.ts";

/**
 * Content for the two-phone mock interview (/game). The interviewer side is
 * written for a native speaker (plain kanji, Japanese UI); the candidate side
 * shows the same text with furigana.
 */

const script = (id: string): Line[] => scripts.find((s) => s.id === id)?.lines ?? [];

/** Interview questions that use the memorised scripts as their model answers. */
export const OPENING: { id: string; q: Line; a: Line[]; note: string; short?: Line[] }[] = [
  {
    id: "intro",
    q: { ja: "では、まず自己紹介をお願いします。", en: "First, please introduce yourself." },
    a: script("self-intro"),
    note: "1分程度で、経歴と強みが伝わるか。",
  },
  {
    id: "reelwalk",
    q: { ja: "ポートフォリオのReelWalkについて、説明していただけますか。", en: "Could you explain ReelWalk, your portfolio project?" },
    a: script("reelwalk-90"),
    short: script("reelwalk-30"),
    note: "何を作ったか、構成、工夫した点の順に話せているか。",
  },
  {
    id: "motivation",
    q: { ja: "弊社{へいしゃ}を志望{しぼう}された理由を教えてください。", en: "Why did you apply to our company?" },
    a: script("motivation"),
    note: "会社の事業や価値観と、自分の経験が結び付いているか。",
  },
  {
    id: "stack",
    q: { ja: "弊社{へいしゃ}の技術スタックとの相性{あいしょう}は、どう考えていますか。", en: "How well do you think you fit our tech stack?" },
    a: script("why-stack"),
    note: "使った技術と、まだ足りない部分を正直に話せているか。",
  },
  {
    id: "aws",
    q: { ja: "AWSでの本番運用{ほんばんうんよう}の経験はありますか。", en: "Do you have experience running production systems on AWS?" },
    a: script("honest-scope"),
    note: "できていないことを正直に言い、代わりに何を検証したかを説明できるか。",
  },
  {
    id: "ask",
    q: { ja: "最後に、何かご質問はありますか。", en: "Finally, do you have any questions for us?" },
    a: company.askThem,
    note: "応募者が質問する番です。自由に答えてあげてください。",
  },
  {
    id: "closing",
    q: { ja: "最後に、何か伝えておきたいことはありますか。", en: "Is there anything else you'd like to tell us?" },
    a: script("closing"),
    note: "短く、前向きに締めくくれているか。",
  },
];

/** Follow-up prompts the interviewer can use on any answer. */
export const FOLLOW_UPS = [
  "具体的には、どういうことですか。",
  "なぜ、その方法を選んだのですか。",
  "一番苦労したのは、どこですか。",
  "もう一度やるとしたら、何を変えますか。",
  "チームで進めるなら、どうしますか。",
  "それを、技術者ではない人に説明してみてください。",
];

/** Reactions the interviewer can send while the candidate is talking. */
export const STAMPS = [
  { id: "good", emoji: "👍", ja: "いいですね", en: "Nice" },
  { id: "detail", emoji: "🔍", ja: "具体的に", en: "Be more specific" },
  { id: "slow", emoji: "🐢", ja: "ゆっくりで大丈夫", en: "Slow down, it's fine" },
  { id: "keigo", emoji: "🎩", ja: "敬語に注意", en: "Mind your keigo" },
  { id: "short", emoji: "✂️", ja: "もう少し短く", en: "A bit shorter" },
  { id: "perfect", emoji: "💯", ja: "完璧！", en: "Perfect!" },
] as const;

/** What the candidate should say aloud when asking for a repeat. */
export const REPEAT_PHRASE: Line = {
  ja: "申し訳ございません。もう一度おっしゃっていただけますか。",
  en: "I'm sorry, could you say that once more?",
};

/** Lifeline costs, in points. */
export const COSTS = { repeat: 0, hint: 2, text: 3 } as const;

export const RATINGS = [
  { id: "content", ja: "内容", en: "Content", hint: "質問に答えているか、具体的か" },
  { id: "japanese", ja: "日本語", en: "Japanese", hint: "文法・語彙・敬語" },
  { id: "delivery", ja: "伝え方", en: "Delivery", hint: "わかりやすさ・落ち着き・時間" },
] as const;

/** Final result, by share of the maximum score. */
export const TITLES: { min: number; ja: string; en: string; emoji: string }[] = [
  { min: 0.85, ja: "内定！おめでとうございます", en: "Job offer!", emoji: "🎉" },
  { min: 0.65, ja: "最終面接へ進めます", en: "Through to the final round", emoji: "🌸" },
  { min: 0.45, ja: "二次面接へ進めます", en: "Through to the second round", emoji: "🍵" },
  { min: 0, ja: "次こそ、いけます", en: "Next time for sure", emoji: "🍙" },
];
