"use client";

import { useEffect, useState } from "react";
import type { Status } from "@/lib/game/relay";

/** Whose turn it is, in the colour of that player: "you" is the person holding this phone. */
export function TurnBanner({ who, ja, sub }: { who: "you" | "them" | "both"; ja: string; sub: string }) {
  return (
    <div className={`turn turn-${who}`} role="status">
      <span className="turn-main">{ja}</span>
      <span className="turn-sub">{sub}</span>
    </div>
  );
}

export function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const s = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  // Around a minute is the sweet spot for most interview answers.
  const zone = s < 20 ? "short" : s <= 120 ? "good" : "long";
  return (
    <span className={`elapsed elapsed-${zone}`}>
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

export function RelayDot({ status, ja = false }: { status: Status; ja?: boolean }) {
  const label = ja
    ? { live: "接続中", connecting: "接続しています…", offline: "オフライン" }[status]
    : { live: "Connected", connecting: "Connecting…", offline: "Offline" }[status];
  return (
    <span className={`relay relay-${status}`}>
      <span className="relay-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Stars({ n }: { n: number }) {
  return (
    <span className="stars" aria-label={`${n} / 5`}>
      {"★★★★★".slice(0, n)}
      <span className="stars-off">{"★★★★★".slice(n)}</span>
    </span>
  );
}
