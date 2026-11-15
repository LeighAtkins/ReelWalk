"use client";
import { useEffect, useId, useRef, useState } from "react";
import { CAMERA_KEYFRAME_MAX_DISTANCE_M } from "@reelwalk/core";

export function parseCameraDistance(value: string): number | null {
  const text = value.trim();
  if (!/^\d+(?:[.,]\d*)?$/.test(text)) return null;
  const number = Number(text.replace(",", "."));
  return Number.isFinite(number) && number >= 0.5 && number <= CAMERA_KEYFRAME_MAX_DISTANCE_M ? number : null;
}

/** Keep an editable string while the customer types; invalid text never replaces the saved intent. */
export function CameraDistanceInput({ value, disabled, onChange, onValidityChange }: {
  value: number; disabled?: boolean; onChange(value: number): void; onValidityChange(valid: boolean): void;
}) {
  const [draft, setDraft] = useState(String(value)), focused = useRef(false), id = useId();
  const valid = parseCameraDistance(draft) !== null;
  useEffect(() => {
    if (!focused.current) { setDraft(String(value)); onValidityChange(true); }
  }, [value, onValidityChange]);
  function edit(text: string) {
    setDraft(text);
    const parsed = parseCameraDistance(text); onValidityChange(parsed !== null);
    if (parsed !== null) onChange(parsed);
  }
  return <label className="field">Distance (about)
    <span style={{ display: "flex", alignItems: "center", gap: ".625rem" }}>
      <input className="text-input" aria-label="Approximate camera distance in metres" type="text" inputMode="decimal"
        value={draft} disabled={disabled} aria-invalid={!valid} aria-describedby={id}
        onFocus={() => { focused.current = true; }} onChange={event => edit(event.target.value)}
        onBlur={() => { focused.current = false; const parsed = parseCameraDistance(draft); if (parsed !== null) setDraft(String(parsed)); }} />m
    </span>
    <span id={id} className={valid ? "muted small" : "error small"}>
      {valid ? "Approximate creative direction, not measured camera geometry." : `Enter a distance from 0.5 to ${CAMERA_KEYFRAME_MAX_DISTANCE_M} metres.`}
    </span>
  </label>;
}
