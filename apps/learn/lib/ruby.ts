/** Parsing for the ruby markup described in lib/types.ts. */

export type Token =
  | { kind: "text"; text: string }
  | { kind: "ruby"; base: string; reading: string; latin: boolean };

const KANJI = "\\u3005\\u3006\\u3400-\\u4DBF\\u4E00-\\u9FFF\\u30F6";
const PATTERN = new RegExp(`\\[([^\\]]+)\\]\\{([^}]+)\\}|([${KANJI}]+)\\{([^}]+)\\}`, "g");

export function parseRuby(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    const start = m.index ?? 0;
    if (start > last) tokens.push({ kind: "text", text: text.slice(last, start) });
    if (m[1] !== undefined) tokens.push({ kind: "ruby", base: m[1], reading: m[2], latin: true });
    else tokens.push({ kind: "ruby", base: m[3], reading: m[4], latin: false });
    last = start + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}

/** Text with readings substituted, for the speech engine. */
export function toSpeech(text: string): string {
  return text.replace(PATTERN, (_all, _lb, lr, _kb, kr) => lr ?? kr).replace(/[【】]/g, "");
}

/** Text with the markup removed, for display in plain contexts. */
export function toPlain(text: string): string {
  return text.replace(PATTERN, (_all, lb, _lr, kb) => lb ?? kb);
}

/** Text written in kana only, for reading practice. */
export function toKana(text: string): string {
  return toSpeech(text);
}
