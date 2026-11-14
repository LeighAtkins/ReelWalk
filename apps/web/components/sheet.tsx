"use client";

import { useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";
import styles from "./sheet.module.css";

type ModalDialogProps = Omit<ComponentPropsWithoutRef<"dialog">, "open" | "onCancel" | "onClose"> & { onRequestClose(): void };

/** Native focus containment and top-layer behavior, with dismissal owned by the caller. */
export function ModalDialog({ onRequestClose, className, children, ...props }: ModalDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropDown = useRef(false);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const opener = document.activeElement;
    node.showModal();
    return () => {
      if (node.open) node.close();
      // React can detach the dialog before this cleanup, bypassing native focus return.
      // Do not focus behind a still-open modal or restore a removed/disabled invoker.
      if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(":disabled") && !opener.closest("[inert], [hidden]")
        && !Array.from(document.querySelectorAll("dialog:modal")).some(modal => !modal.contains(opener))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  const outside = (event: React.PointerEvent<HTMLDialogElement> | React.MouseEvent<HTMLDialogElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  return <dialog {...props} ref={dialog} className={`${styles.native} ${className ?? ""}`}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onRequestClose(); }}
    onPointerDown={event => { backdropDown.current = outside(event); }}
    onPointerCancel={() => { backdropDown.current = false; }}
    onClick={event => { const dismiss = backdropDown.current && outside(event); backdropDown.current = false; if (dismiss) onRequestClose(); }}>
    {children}
  </dialog>;
}

/** A blocking full-height workflow; the scrolling body and fixed footer stay unchanged. */
export function ModalPanel({ labelledBy, onClose, children }: { labelledBy: string; onClose(): void; children: ReactNode }) {
  return <ModalDialog className={`panel ${styles.fullScreen}`} aria-labelledby={labelledBy} onRequestClose={onClose}>{children}</ModalDialog>;
}

/**
 * A bottom sheet: the editor's tool panels, and the export screen's sound
 * picker. Escape, the backdrop, the close button or a drag down closes it;
 * a drag up opens it to full height.
 */
export function Sheet({ title, onClose, children, size = "standard" }: { title: string; onClose(): void; children: ReactNode; size?: "standard" | "wide" }) {
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [pull, setPull] = useState<number | null>(null);
  const gesture = useRef<(() => void) | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => () => gesture.current?.(), []);

  // The grip and title bar drag: down closes the sheet, up opens it to full
  // height, a tap toggles. Works with a finger or a mouse.
  function onGrab(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    gesture.current?.();
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let dy = 0;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      dy = e.clientY - startY;
      setPull(Math.max(0, dy));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      gesture.current = null;
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      setPull(null);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      setPull(null);
      if (dy > 80) onCloseRef.current();
      else if (dy < -30) setExpanded(true);
      else if (Math.abs(dy) < 5) setExpanded((current) => !current);
    };
    gesture.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  }

  return (
      <ModalDialog
        className={`sheet ${styles.bottomSheet}`}
        onRequestClose={onClose}
        aria-labelledby={titleId}
        data-size={size}
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
      </ModalDialog>
  );
}
