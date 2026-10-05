import Link from "next/link";
import type { Status, Topic, Video } from "@/lib/types";
import { STATUS_LABEL } from "@/lib/groups";
import { topicCode } from "@/lib/content";
import { Ja } from "./Ja";

export function Badge({ topic, large = false }: { topic: Topic; large?: boolean }) {
  const c = topicCode(topic);
  return (
    <span className={`badge${large ? " badge-lg" : ""}`} style={{ "--c": c.color } as React.CSSProperties} aria-hidden="true">
      <span>
        <small>{c.letter}</small>
        {String(c.num).padStart(2, "0")}
      </span>
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status].en}</span>;
}

export function Station({ topic }: { topic: Topic }) {
  return (
    <Link href={`/topics/${topic.id}/`} className="station">
      <Badge topic={topic} />
      <span className="station-text">
        <span className="station-name">{topic.name}</span>
        <span className="station-ja">
          <Ja text={topic.ja} />
        </span>
      </span>
    </Link>
  );
}

const LEVEL = { intro: "beginner", intermediate: "intermediate", deep: "in depth" } as const;

export function VideoList({ videos }: { videos: Video[] }) {
  return (
    <div className="videos">
      {videos.map((v) => (
        <a key={v.id} className="video" href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer">
          <img src={`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" loading="lazy" />
          <span>
            <span className="video-title" lang="ja">
              {v.title}
            </span>
            <span className="video-meta">
              {v.channel}, {LEVEL[v.level]}
            </span>
            <span className="video-note" style={{ display: "block" }}>
              {v.note}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}

export function SearchLinks({ queries }: { queries: string[] }) {
  return (
    <div className="pill-links">
      {queries.map((q) => (
        <a key={q} href={`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`} target="_blank" rel="noreferrer" lang="ja">
          ▶ {q}
        </a>
      ))}
    </div>
  );
}
