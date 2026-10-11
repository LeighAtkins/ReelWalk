"use client";

import { useLinkStatus } from "next/link";

/**
 * Inside a Link: focus marks that close in while the page it opens is on its
 * way, so a tap always shows. Always rendered, so nothing shifts.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return (
    <span className="link-pending" data-pending={pending} aria-hidden="true">
      <span className="focus-marks" />
    </span>
  );
}
