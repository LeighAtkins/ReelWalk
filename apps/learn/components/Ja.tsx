import { parseRuby } from "@/lib/ruby";

/** Japanese text with furigana from the ruby markup. */
export function Ja({ text, className }: { text: string; className?: string }) {
  return (
    <span lang="ja" className={className}>
      {parseRuby(text).map((t, i) =>
        t.kind === "text" ? (
          t.text
        ) : (
          <ruby key={i} className={t.latin ? "say" : undefined}>
            {t.base}
            <rp>(</rp>
            <rt>{t.reading}</rt>
            <rp>)</rp>
          </ruby>
        ),
      )}
    </span>
  );
}
