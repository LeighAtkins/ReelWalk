import { Suspense } from "react";
import { Candidate } from "@/components/game/Candidate";

export const metadata = { title: "Candidate: mock interview game" };

export default function CandidatePage() {
  return (
    <Suspense>
      <Candidate />
    </Suspense>
  );
}
