import Link from "next/link";
import { notFound } from "next/navigation";
import { scripts } from "@/lib/content";
import { Ja } from "@/components/Ja";
import { LineList } from "@/components/LineList";

export function generateStaticParams() {
  return scripts.map((s) => ({ id: s.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = scripts.find((x) => x.id === id);
  return { title: s ? `${s.title.en}: ReelWalk 面接ノート` : "Not found" };
}

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const i = scripts.findIndex((s) => s.id === id);
  if (i < 0) notFound();
  const script = scripts[i];
  const next = scripts[i + 1];
  const hasBlanks = script.lines.some((l) => l.ja.includes("【"));

  return (
    <article className="stack">
      <header className="stack" style={{ gap: 8 }}>
        <Link href="/practice/" className="note">
          ‹ All scripts
        </Link>
        <h1>{script.title.en}</h1>
        <p className="topic-say">
          <Ja text={script.title.ja} /> · about {script.seconds} seconds
        </p>
        <p className="lede">{script.intro}</p>
        {hasBlanks && (
          <p className="placeholder-hint">
            Replace each 【】 with your own facts, and say the finished version aloud. The audio reads the placeholder text as written.
          </p>
        )}
      </header>
      <section className="block">
        <LineList lines={script.lines} practice numbered />
      </section>
      <p className="note">
        To memorise: play it twice, shadow it once, then turn on <strong>Hide Japanese</strong> and say each line before tapping to check.
      </p>
      {next && (
        <Link className="btn btn-ink" href={`/practice/${next.id}/`} style={{ alignSelf: "flex-end" }}>
          Next: {next.title.en} ›
        </Link>
      )}
    </article>
  );
}
