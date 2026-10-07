"use client";

import { useEffect } from "react";

/**
 * The editor's strips (timeline, toolbar, looks) scroll sideways, which a
 * phone does by swiping. A desktop mouse wheel only scrolls up and down, so
 * a wheel over a sideways strip moves it sideways instead.
 */
export function WheelScroll() {
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      for (let node = event.target as HTMLElement | null; node && node !== document.body; node = node.parentElement) {
        if (node.scrollWidth <= node.clientWidth + 1) continue;
        const style = getComputedStyle(node);
        if (style.overflowX !== "auto" && style.overflowX !== "scroll") continue;
        // A box that also scrolls vertically keeps the wheel for that.
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return;
        node.scrollLeft += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        event.preventDefault();
        return;
      }
    };
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);
  return null;
}
