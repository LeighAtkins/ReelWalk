import Link from "next/link";
import { Countdown, Plan } from "@/components/Plan";
import { Ja } from "@/components/Ja";
import { Speak } from "@/components/Speak";
import { OPENER, VOICES } from "@/content/misc";

export default function Home() {
  return (
    <div className="stack">
      <section className="hero">
        <Countdown />
        <h1>
          Explain ReelWalk in Japanese, stop by stop
          <span lang="ja">ReelWalkを日本語で説明する</span>
        </h1>
      </section>

      <section className="one-liner" aria-label="Your first line in the interview">
        <Speak text={OPENER.ja} />
        <div className="line-body">
          <p className="ja-line">
            <Ja text={OPENER.ja} />
          </p>
          <p className="en-line">{OPENER.en}</p>
        </div>
      </section>

      <section>
        <h2 style={{ marginBottom: 10 }}>Four days to Thursday</h2>
        <Plan />
      </section>

      <section className="block">
        <h2>How this works</h2>
        <ul className="list-links">
          <li>
            <Link href="/map/">
              <span>
                <span className="list-title">Route map</span>
                <br />
                <span className="list-ja">Every service as a station; follow a request through them.</span>
              </span>
              <span className="secs">›</span>
            </Link>
          </li>
          <li>
            <Link href="/topics/">
              <span>
                <span className="list-title">Lessons</span>
                <br />
                <span className="list-ja">29 stops: what it does, why ReelWalk uses it, how to say it.</span>
              </span>
              <span className="secs">›</span>
            </Link>
          </li>
          <li>
            <Link href="/practice/">
              <span>
                <span className="list-title">Interview practice</span>
                <br />
                <span className="list-ja">Scripts to memorise, a question drill with recording, useful phrases.</span>
              </span>
              <span className="secs">›</span>
            </Link>
          </li>
          <li>
            <Link href="/listen/">
              <span>
                <span className="list-title">Listen</span>
                <br />
                <span className="list-ja">Hands-free playback for the train, and Japanese videos on each topic.</span>
              </span>
              <span className="secs">›</span>
            </Link>
          </li>
        </ul>
        <p className="note" style={{ marginTop: 10 }}>
          The <strong>振</strong> button at the top switches furigana, <strong>EN</strong> hides English until you tap it, and the speed button sets the
          voice and pace. Add this page to your home screen to open it like an app.
        </p>
        <p className="note" style={{ marginTop: 8 }}>
          Recorded audio: {VOICES.map((v) => v.credit).join(", ")}.
        </p>
      </section>
    </div>
  );
}
