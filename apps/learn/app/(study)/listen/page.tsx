import { generalQA, phraseSets, scripts, topics, videos } from "@/lib/content";
import { toPlain } from "@/lib/ruby";
import { TALKING_POINTS } from "@/content/talking-points";
import { Listen, type Playlist } from "@/components/Listen";
import { VideoList } from "@/components/Bits";
import Link from "next/link";

export const metadata = { title: "聞く: listen and watch" };

export default function ListenPage() {
  const playlists: Playlist[] = [
    { id: "talking-all", group: "Talking points", title: "All short things to say", lines: TALKING_POINTS.flatMap((g) => g.points) },
    ...TALKING_POINTS.map((g) => ({ id: `talking-${g.id}`, group: "Talking points", title: g.title.en, lines: g.points })),
    ...scripts.map((s) => ({ id: `script-${s.id}`, group: "Interview scripts", title: s.title.en, lines: s.lines })),
    {
      id: "general-qa",
      group: "Interview questions",
      title: "General questions with model answers",
      lines: generalQA.flatMap((qa) => [qa.q, ...qa.a]),
    },
    ...phraseSets.map((p) => ({ id: `phrases-${p.id}`, group: "Phrases", title: toPlain(p.title.ja), lines: p.phrases })),
    ...topics.map((t) => ({ id: `topic-${t.id}`, group: "Lessons", title: t.name, lines: [t.oneLiner, ...t.explain, ...t.why] })),
  ];
  const interview = videos.filter((v) => v.topics.includes("interview"));
  const tech = videos.filter((v) => !v.topics.includes("interview"));

  return (
    <div className="stack">
      <div>
        <h1>Listen</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          Play a script or lesson end to end, or shadow it: each line plays, then pauses long enough for you to say it back.
        </p>
      </div>
      <Link className="btn btn-ink" href="/say/" style={{ alignSelf: "flex-start" }}>
        Everything to say, on one page
      </Link>
      <Listen playlists={playlists} />
      <section id="videos" className="block">
        <h2 style={{ marginBottom: 4 }}>Japanese interviews, by native speakers</h2>
        <p className="note" style={{ marginBottom: 12 }}>
          How interviews flow, self-introductions, questions to ask. Opens in YouTube.
        </p>
        <VideoList videos={interview} />
      </section>
      <section className="block">
        <h2 style={{ marginBottom: 4 }}>The stack, explained in Japanese</h2>
        <p className="note" style={{ marginBottom: 12 }}>
          Listen for how engineers phrase things. Every lesson also links its own videos and searches.
        </p>
        <VideoList videos={tech} />
      </section>
    </div>
  );
}
