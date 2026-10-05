import { Suspense } from "react";
import { drill, topics } from "@/lib/content";
import { Drill } from "@/components/Drill";

export const metadata = { title: "Question drill: ReelWalk 面接ノート" };

export default function DrillPage() {
  const names = Object.fromEntries(topics.map((t) => [t.id, t.name]));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Question drill</h1>
      <Suspense>
        <Drill items={drill} names={names} />
      </Suspense>
    </div>
  );
}
