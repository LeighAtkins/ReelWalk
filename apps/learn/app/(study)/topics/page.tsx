import { topics } from "@/lib/content";
import { GROUP_ORDER, GROUPS } from "@/lib/groups";
import { Station } from "@/components/Bits";
import { Ja } from "@/components/Ja";

export const metadata = { title: "学ぶ: every piece of ReelWalk" };

export default function TopicsPage() {
  return (
    <div className="stack">
      <div>
        <h1>Every piece, one stop at a time</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          Each line is a part of the system. Open a stop to hear how a Japanese engineer explains it, see where it lives in the repo, and drill the
          interview questions about it.
        </p>
      </div>
      {GROUP_ORDER.map((g) => {
        const list = topics.filter((t) => t.group === g);
        if (list.length === 0) return null;
        return (
          <section key={g} className="block">
            <h2 className="row">
              {GROUPS[g].en}
              <span lang="ja" style={{ fontSize: 15, color: "var(--muted)" }}>
                <Ja text={GROUPS[g].ja} />
              </span>
            </h2>
            <ul className="line-strip" style={{ "--c": GROUPS[g].color } as React.CSSProperties}>
              {list.map((t) => (
                <li key={t.id}>
                  <Station topic={t} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
