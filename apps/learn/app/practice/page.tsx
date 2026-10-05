import Link from "next/link";
import { company, scripts } from "@/lib/content";
import { Ja } from "@/components/Ja";
import { LineList } from "@/components/LineList";

export const metadata = { title: "面接: interview practice" };

export default function PracticePage() {
  return (
    <div className="stack">
      <div>
        <h1>Interview practice</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          Memorise the scripts, then drill questions out loud. Parts in 【】 are yours to fill in with your own background.
        </p>
      </div>

      <section className="block">
        <h2>Scripts to memorise</h2>
        <ul className="list-links">
          {scripts.map((s) => (
            <li key={s.id}>
              <Link href={`/practice/${s.id}/`}>
                <span>
                  <span className="list-title">{s.title.en}</span>
                  <br />
                  <span className="list-ja">
                    <Ja text={s.title.ja} />
                  </span>
                </span>
                <span className="secs">{s.seconds >= 60 ? `${Math.round(s.seconds / 6) / 10} min` : `${s.seconds} s`}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="block stack" style={{ gap: 10 }}>
        <h2>Question drill</h2>
        <p className="note">A question is read aloud; you answer, record yourself, then compare with a model answer.</p>
        <div className="row wrap">
          <Link className="btn btn-ink" href="/drill/">
            Start the drill
          </Link>
          <Link className="btn" href="/phrases/">
            Useful phrases
          </Link>
        </div>
      </section>

      <section className="block">
        <h2 style={{ marginBottom: 4 }}>About Craftsman Software</h2>
        <p className="note" style={{ marginBottom: 8 }}>
          Facts from their own site and job post, phrased the way you'd use them in 志望動機.
        </p>
        <LineList lines={company.facts.map((f) => f.line)} />
        <details style={{ marginTop: 8 }}>
          <summary className="note">Sources</summary>
          <ul className="refs" style={{ marginTop: 8 }}>
            {[...new Set(company.facts.map((f) => f.source))].map((u) => (
              <li key={u}>
                <a href={u} target="_blank" rel="noreferrer">
                  {u}
                </a>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="block" id="ask">
        <h2 style={{ marginBottom: 4 }}>Questions to ask them</h2>
        <p className="note" style={{ marginBottom: 8 }}>
          For 「何か質問はありますか」 at the end. Pick two.
        </p>
        <LineList lines={company.askThem} practice />
      </section>
    </div>
  );
}
