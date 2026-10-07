import { LIFELINES, TOP_QUESTIONS } from "@/content/cheat-sheet";
import { OPENER } from "@/content/misc";
import { TALKING_POINTS } from "@/content/talking-points";
import { SayAll, type SaySection } from "@/components/SayAll";

export const metadata = { title: "話す: everything to say" };

export default function SayPage() {
  const sections: SaySection[] = [
    { id: "open", title: "First words", lines: [OPENER] },
    ...TALKING_POINTS.map((g) => ({ id: g.id, title: g.title.en, hook: g.hook, lines: g.points })),
    {
      id: "ask",
      title: "If they ask… say",
      lines: TOP_QUESTIONS.flatMap((qa) => [{ ...qa.q, cue: true }, qa.a]),
    },
    { id: "second", title: "When you need a second", lines: LIFELINES },
  ];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Everything to say</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          All the Japanese from the cheat sheet on one page. Tap a line to hear it, or play it all and follow along. Shadowing leaves a pause after each line
          for you to repeat it.
        </p>
      </div>
      <SayAll sections={sections} />
    </div>
  );
}
