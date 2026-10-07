"use client";

import { useEffect, useRef } from "react";
import type { Line } from "@/lib/types";
import { Ja } from "./Ja";
import { PlayAll, usePlaylist } from "./LineList";
import { Speak } from "./Speak";

export interface SaySection {
  id: string;
  title: string;
  hook?: string;
  /** Lines in order; a line marked `cue` is what you hear, not what you say. */
  lines: (Line & { cue?: boolean })[];
}

/** Every line to say, in sections, with one playlist across the whole page. */
export function SayAll({ sections }: { sections: SaySection[] }) {
  const all = sections.flatMap((s) => s.lines);
  const list = usePlaylist(all.map((l) => l.ja));
  const rows = useRef<(HTMLLIElement | null)[]>([]);

  // Keep the line being read on screen.
  useEffect(() => {
    if (list.index >= 0) rows.current[list.index]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [list.index]);

  let n = -1;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="say-bar">
        <PlayAll list={list} />
        <span className="note">{all.length} lines</span>
      </div>
      <nav className="section-nav" aria-label="Sections" style={{ position: "static" }}>
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.title}
          </a>
        ))}
      </nav>
      {sections.map((s) => (
        <section key={s.id} id={s.id} className="block">
          <h2>{s.title}</h2>
          {s.hook && <p className="say-hook">{s.hook}</p>}
          <ol className="say-list">
            {s.lines.map((l) => {
              n++;
              const i = n;
              return (
                <li
                  key={i}
                  ref={(el) => {
                    rows.current[i] = el;
                  }}
                  className="line"
                  data-current={list.index === i || undefined}
                  data-cue={l.cue || undefined}
                >
                  <Speak text={l.ja} size="sm" />
                  <div className="line-body">
                    {l.cue && <span className="say-tag">They ask</span>}
                    <p className="ja-line">
                      <Ja text={l.ja} />
                    </p>
                    <p className="en-line">{l.en}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
