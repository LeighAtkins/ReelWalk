import { Suspense } from "react";
import { deck, topics } from "@/lib/content";
import { Flashcards } from "@/components/Flashcards";

export const metadata = { title: "単語: flashcards" };

export default function WordsPage() {
  const groupOf = Object.fromEntries(topics.map((t) => [t.id, t.group]));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Words</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          Every term from the lessons. Missed cards come back a few cards later; three right answers in a row marks a word as known.
        </p>
      </div>
      <Suspense>
        <Flashcards deck={deck} groupOf={groupOf} />
      </Suspense>
    </div>
  );
}
