"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-runs the surrounding Server Components on an interval while a render is
 * in flight, so progress and status come from the server without a client
 * data-fetching layer. Stops as soon as nothing is active.
 */
export function AutoRefresh({ active, intervalMs = 2000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);

  return null;
}
