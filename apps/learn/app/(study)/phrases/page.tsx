import { phraseSets } from "@/lib/content";
import { Ja } from "@/components/Ja";
import { LineList } from "@/components/LineList";

export const metadata = { title: "Phrases: ReelWalk 面接ノート" };

export default function PhrasesPage() {
  return (
    <div className="stack">
      <div>
        <h1>Phrases that keep you talking</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          For the moments between technical answers: asking again, buying a few seconds, admitting what you haven't done.
        </p>
      </div>
      <nav className="section-nav" aria-label="Phrase sets">
        {phraseSets.map((p) => (
          <a key={p.id} href={`#${p.id}`} lang="ja">
            {p.title.ja.replace(/\{[^}]*\}/g, "")}
          </a>
        ))}
      </nav>
      {phraseSets.map((p) => (
        <section key={p.id} id={p.id} className="block">
          <h2>
            {p.title.en}{" "}
            <span lang="ja" style={{ fontSize: 15, color: "var(--muted)" }}>
              <Ja text={p.title.ja} />
            </span>
          </h2>
          <p className="note" style={{ margin: "6px 0 8px" }}>
            {p.intro}
          </p>
          <LineList lines={p.phrases.map((x) => ({ ja: x.ja, en: x.when ? `${x.en} (${x.when})` : x.en }))} practice />
        </section>
      ))}
    </div>
  );
}
