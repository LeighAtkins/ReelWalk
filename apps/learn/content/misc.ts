/** One-off spoken lines used outside the main content files. */

export const OPENER = {
  ja: "本日{ほんじつ}はお時間をいただき、ありがとうございます。よろしくお願{ねが}いいたします。",
  en: "Thank you for your time today. I look forward to speaking with you.",
};

export const VOICE_TEST = {
  ja: "冪等性{べきとうせい}を意識{いしき}して、ワーカーを設計{せっけい}しました。",
  en: "I designed the worker with idempotency in mind.",
};

/** VOICEVOX characters used for the recorded audio; their terms require these credits. */
export const VOICES = [
  { id: "ryusei", credit: "VOICEVOX:青山龍星", label: "Calm male voice" },
  { id: "no7", credit: "VOICEVOX:No.7", label: "Newsreader female voice" },
] as const;
