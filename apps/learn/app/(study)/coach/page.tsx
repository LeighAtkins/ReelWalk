import { Suspense } from "react";
import { Coach } from "@/components/Coach";

export const metadata = { title: "Talking-points coach: ReelWalk 面接ノート" };

export default function CoachPage() {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Talking-points coach</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          One answer at a time, in four small steps: listen slowly, repeat each point in short breaths, say it from cue words, then on your own. No
          scores, no rush.
        </p>
      </div>
      <Suspense>
        <Coach />
      </Suspense>
    </div>
  );
}
