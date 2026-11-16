"use client";
import { useId, useRef } from "react";
import { cameraSketchIntent, clampSketchPoint, DEFAULT_CAMERA_SKETCH, type CameraSketch } from "./camera-sketch";
import styles from "./shot-workspace.module.css";

export function CameraSketchControl({ value, disabled, onChange }: { value?: CameraSketch; disabled: boolean; onChange(value: CameraSketch): void }) {
  const sketch = value ?? DEFAULT_CAMERA_SKETCH;
  const stage = useRef<HTMLDivElement>(null), drag = useRef<"start" | "end" | null>(null);
  const id = useId(), intent = cameraSketchIntent(sketch);
  function edit(role: "start" | "end", x: number, y: number) { onChange({ ...sketch, [role]: clampSketchPoint(x, y) }); }
  return <fieldset className={styles.sketch} disabled={disabled}>
    <legend>Sketch your camera move</legend>
    <p id={id} className={styles.hint}>Drag Start and End, or use the position sliders. This is a top-down direction sketch, not a map of your photo. Up means forward. Sketch distance is approximate creative guidance; unseen architecture is interpreted by AI.</p>
    <div ref={stage} className={styles.sketchStage} onPointerMove={event => {
      if (!drag.current || disabled || !stage.current) return;
      const box = stage.current.getBoundingClientRect();
      edit(drag.current, (event.clientX - box.left) / box.width * 100 - 50, (event.clientY - box.top) / box.height * 100 - 50);
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <svg viewBox="-50 -50 100 100" aria-hidden="true" preserveAspectRatio="none">
        <rect x="-12" y="-30" width="24" height="18" rx="2" fill="none" stroke="currentColor" />
        <text x="0" y="-21" textAnchor="middle" fontSize="4" fill="currentColor">PROPERTY</text>
        <path d={`M ${sketch.start.x} ${sketch.start.y} L ${sketch.end.x} ${sketch.end.y}`} stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
      {(["start", "end"] as const).map(role => <button key={role} type="button" className={styles.sketchHandle} style={{ left: `${sketch[role].x + 50}%`, top: `${sketch[role].y + 50}%` }} aria-label={`Camera ${role} position`} aria-describedby={id}
        onPointerDown={event => { if (disabled || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = role; }}
        onKeyDown={event => {
          const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
          if (!delta) return; event.preventDefault(); edit(role, sketch[role].x + delta[0], sketch[role].y + delta[1]);
        }}>{role === "start" ? "Start" : "End"}</button>)}
    </div>
    {(["start", "end"] as const).map(role => <div key={role} className={styles.sketchPositions}>
      <strong>{role === "start" ? "Start" : "End"} position</strong>
      {(["x", "y"] as const).map(axis => <label key={axis}>{axis === "x" ? "Left / right" : "Forward / back"} <output>{sketch[role][axis]}</output>
        <input type="range" min={-50} max={50} step={1} aria-label={`${role} ${axis === "x" ? "left or right" : "forward or back"}`} value={sketch[role][axis]} onChange={event => edit(role, axis === "x" ? Number(event.target.value) : sketch[role].x, axis === "y" ? Number(event.target.value) : sketch[role].y)} />
      </label>)}
    </div>)}
    <p role="status" className={styles.hint}>{value ? intent ? `Sketch applied: ${intent.move.replaceAll("-", " ")}, approximately ${intent.distanceM} m. The controls below show the guidance that will be sent.` : "Separate Start and End by at least 5 sketch units before preparing images or video." : "Move either handle to apply your sketch. The controls below are used until then."}</p>
  </fieldset>;
}
