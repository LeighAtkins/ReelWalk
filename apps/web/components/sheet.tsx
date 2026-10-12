"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CloseIcon } from "./icons";

/**
 * A bottom sheet: the editor's tool panels, and the export screen's sound
 * picker. Escape, the backdrop, the close button or a drag down closes it;
 * a drag up opens it to full height.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [pull, setPull] = useState<number | null>(null);

  // The grip and title bar drag: down closes the sheet, up opens it to full
  // height, a tap toggles. Works with a finger or a mouse.
  function onGrab(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const startY = event.clientY;
    let dy = 0;
    const move = (e: PointerEvent) => {
      dy = e.clientY - startY;
      setPull(Math.max(0, dy));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setPull(null);
      if (dy > 80) onClose();
      else if (dy < -30) setExpanded(true);
      else if (Math.abs(dy) < 5) setExpanded((current) => !current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input, textarea, button:not(.sheet-close)")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
        data-expanded={expanded || undefined}
        style={pull !== null ? { transform: `translate(-50%, ${pull}px)`, transition: "none" } : undefined}
      >
        <div className="sheet-handle" onPointerDown={onGrab} title={expanded ? "Drag down to close" : "Drag up for more room, down to close"}>
          <span className="sheet-grip" aria-hidden="true" />
          <div className="sheet-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn sheet-close" aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>
  );
}
