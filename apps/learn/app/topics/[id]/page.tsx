import Link from "next/link";
import { notFound } from "next/navigation";
import { topicById, topics, videosFor } from "@/lib/content";
import { STATUS_LABEL } from "@/lib/groups";
import { Badge, SearchLinks, Station, StatusPill, VideoList } from "@/components/Bits";
import { Ja } from "@/components/Ja";
import { LineList } from "@/components/LineList";
import { Speak } from "@/components/Speak";

const REPO = "https://github.com/LeighAtkins/ReelWalk/blob/feat/reels-editor/";

export function generateStaticParams() {
  return topics.map((t) => ({ id: t.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const t = topicById((await params).id);
  return { title: t ? `${t.name}: ReelWalk 面接ノート` : "Not found" };
}

export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const topic = topicById((await params).id);
  if (!topic) notFound();
  const i = topics.indexOf(topic);
  const prev = topics[i - 1];
  const next = topics[i + 1];
  const vids = videosFor(topic.id);
  const related = topic.related.map(topicById).filter((t) => t !== undefined);

  return (
    <article className="stack">
      <header className="stack" style={{ gap: 12 }}>
        <div className="topic-head">
          <Badge topic={topic} large />
          <div>
            <h1>{topic.name}</h1>
            <p className="topic-say row">
              <Ja text={topic.ja} />
            </p>
          </div>
        </div>
        <div className="row wrap">
          <Speak text={topic.say} size="sm" label={`Say ${topic.name}`} />
          <span lang="ja" style={{ fontSize: 15 }}>
            {topic.say}
          </span>
          <span style={{ flex: 1 }} />
          <StatusPill status={topic.status} />
        </div>
        <div className="one-liner">
          <Speak text={topic.oneLiner.ja} />
          <div className="line-body">
            <p className="ja-line">
              <Ja text={topic.oneLiner.ja} />
            </p>
            <p className="en-line">{topic.oneLiner.en}</p>
          </div>
        </div>
        <p className="status-note">
          <strong lang="ja">
            <Ja text={STATUS_LABEL[topic.status].ja} />
          </strong>{" "}
          {topic.statusNote}
        </p>
      </header>

      <nav className="section-nav" aria-label="On this page">
        <a href="#explain">Explain</a>
        <a href="#why">Why</a>
        <a href="#words">Words</a>
        <a href="#interview">Interview</a>
        <a href="#repo">In the repo</a>
        <a href="#watch">Watch</a>
      </nav>

      <section id="explain" className="block">
        <h2>
          How to explain it
        </h2>
        <LineList lines={topic.explain} practice />
      </section>

      <section id="why" className="block">
        <h2>Why ReelWalk uses it</h2>
        <LineList lines={topic.why} practice />
      </section>

      <section id="words" className="block">
        <h2>Words to use</h2>
        <dl className="terms">
          {topic.terms.map((term) => (
            <div key={term.ja} className="term">
              <Speak text={term.ja} size="sm" />
              <div>
                <dt>
                  <Ja text={term.ja} />
                </dt>
                <dd>
                  {term.en}
                  {term.note && <span className="term-note">{term.note}</span>}
                </dd>
              </div>
            </div>
          ))}
        </dl>
      </section>

      <section id="interview" className="block">
        <h2>Interview questions</h2>
        <div className="stack" style={{ gap: 14 }}>
          {topic.qa.map((qa, n) => (
            <details key={n} className="qa">
              <summary>
                <Speak text={qa.q.ja} size="sm" />
                <span>
                  <span className="qa-q" style={{ display: "block" }}>
                    <Ja text={qa.q.ja} />
                  </span>
                  <span className="qa-qen">{qa.q.en}</span>
                </span>
              </summary>
              <LineList lines={qa.a} practice />
              {qa.tip && <p className="tip">{qa.tip}</p>}
            </details>
          ))}
        </div>
        <p style={{ marginTop: 14 }}>
          <Link className="btn" href={`/drill/?topic=${topic.id}`}>
            Drill these out loud
          </Link>
        </p>
      </section>

      <section id="repo" className="block">
        <h2>Where it lives in ReelWalk</h2>
        <ul className="refs">
          {topic.inRepo.map((r) => (
            <li key={r.path}>
              <a href={REPO + r.path} target="_blank" rel="noreferrer">
                {r.path}
              </a>
              <p>{r.what}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="watch" className="block">
        <h2>Listen to native speakers</h2>
        {vids.length > 0 ? (
          <VideoList videos={vids} />
        ) : (
          <p className="note">No hand-picked video for this one yet. These YouTube searches find Japanese talks about it:</p>
        )}
        <div style={{ marginTop: 14 }}>
          <SearchLinks queries={topic.videoSearch} />
        </div>
        {topic.docs.length > 0 && (
          <>
            <h3 style={{ margin: "18px 0 8px" }}>Official docs</h3>
            <ul className="refs">
              {topic.docs.map((d) => (
                <li key={d.url}>
                  <a href={d.url} target="_blank" rel="noreferrer" style={{ fontFamily: "inherit", fontSize: 15 }}>
                    {d.title}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {related.length > 0 && (
        <section className="block">
          <h2>Connected stops</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {related.map((t) => (
              <li key={t.id}>
                <Station topic={t} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav className="row" style={{ justifyContent: "space-between" }} aria-label="Previous and next">
        {prev ? (
          <Link className="btn" href={`/topics/${prev.id}/`}>
            ‹ {prev.name}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link className="btn btn-ink" href={`/topics/${next.id}/`}>
            {next.name} ›
          </Link>
        )}
      </nav>
    </article>
  );
}
