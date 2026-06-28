import React, { useRef, useState, useCallback } from "react";

interface PanoFramerProps {
  imageUrl: string;
  startAngle: number;
  endAngle: number;
  startPitch: number;
  endPitch: number;
  fov: number;
  onChange: (update: {
    startAngle: number;
    endAngle: number;
    startPitch: number;
    endPitch: number;
    fov: number;
  }) => void;
}

/**
 * Spherical pano framer with delta-based dragging.
 *
 * DragHandle manages its own touch/mouse session internally and calls
 * onChange with computed yaw/pitch. No re-render dependency during drag.
 */
export const PanoFramer: React.FC<PanoFramerProps> = ({
  imageUrl,
  startAngle,
  endAngle,
  startPitch,
  endPitch,
  fov,
  onChange,
}) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const [activeDrag, setActiveDrag] = useState<"start" | "end" | null>(null);

  // Latest props in ref — callbacks read from here, not closure
  const latest = useRef({ startAngle, endAngle, startPitch, endPitch, fov, onChange });
  latest.current = { startAngle, endAngle, startPitch, endPitch, fov, onChange };

  const angleToX = (yaw: number) => (((yaw % 360) + 360) % 360) / 360 * 100;
  const pitchToY = (pitch: number) => (90 - pitch) / 180 * 100;
  // FOV rectangles — reflect vertical output aspect ratio
  // For a 9:16 video, vertical FOV is much larger than horizontal
  const d2r = (d: number) => d * Math.PI / 180;
  const outAspect = 9 / 16; // width / height (vertical video)
  const fovXPct = fov / 360 * 100;
  const vFov = 2 * Math.atan(Math.tan(d2r(fov) / 2) / outAspect) * 180 / Math.PI;
  const fovYPct = vFov / 180 * 100;

  const startXPct = angleToX(startAngle);
  const startYPct = pitchToY(startPitch);
  const endXPct = angleToX(endAngle);
  const endYPct = pitchToY(endPitch);

  return (
    <div className="pano-framer">
      <div className="framer-label">Drag START and END dots to frame the camera view</div>

      <div className="pano-strip-wrapper">
        <div className="pano-strip" ref={stripRef}>
          <img src={imageUrl} className="pano-img" alt="360 panorama" draggable={false} />

          <FovRect xPct={startXPct} yPct={startYPct} fovXPct={fovXPct} fovYPct={fovYPct} color="#4a8aff" />
          <FovRect xPct={endXPct} yPct={endYPct} fovXPct={fovXPct} fovYPct={fovYPct} color="#16a884" />
          <PanArrow fromX={startXPct} fromY={startYPct} toX={endXPct} toY={endYPct} />

          <DragHandle
            xPct={startXPct} yPct={startYPct} color="#4a8aff"
            label="START" angle={Math.round(startAngle)} pitch={Math.round(startPitch)}
            active={activeDrag === "start"}
            stripRef={stripRef}
            type="start"
            latestRef={latest}
            onActiveChange={(a) => setActiveDrag(a ? "start" : null)}
          />
          <DragHandle
            xPct={endXPct} yPct={endYPct} color="#16a884"
            label="END" angle={Math.round(endAngle)} pitch={Math.round(endPitch)}
            active={activeDrag === "end"}
            stripRef={stripRef}
            type="end"
            latestRef={latest}
            onActiveChange={(a) => setActiveDrag(a ? "end" : null)}
          />
        </div>
      </div>

      {/* Numeric controls */}
      <div className="angle-grid">
        <div className="angle-group">
          <div className="angle-group-label" style={{ color: "#4a8aff" }}>● START</div>
          <div className="angle-row">
            <label>Yaw</label>
            <input type="number" min={0} max={360} value={Math.round(startAngle)}
              onChange={(e) => onChange({ startAngle: Number(e.target.value), endAngle, startPitch, endPitch, fov })} />
            <span>°</span>
          </div>
          <div className="angle-row">
            <label>Pitch</label>
            <input type="number" min={-85} max={85} value={Math.round(startPitch)}
              onChange={(e) => onChange({ startAngle, endAngle, startPitch: Number(e.target.value), endPitch, fov })} />
            <span>°</span>
          </div>
        </div>
        <div className="angle-arrow">→</div>
        <div className="angle-group">
          <div className="angle-group-label" style={{ color: "#16a884" }}>● END</div>
          <div className="angle-row">
            <label>Yaw</label>
            <input type="number" min={0} max={360} value={Math.round(endAngle)}
              onChange={(e) => onChange({ startAngle, endAngle: Number(e.target.value), startPitch, endPitch, fov })} />
            <span>°</span>
          </div>
          <div className="angle-row">
            <label>Pitch</label>
            <input type="number" min={-85} max={85} value={Math.round(endPitch)}
              onChange={(e) => onChange({ startAngle, endAngle, startPitch, endPitch: Number(e.target.value), fov })} />
            <span>°</span>
          </div>
        </div>
      </div>

      <div className="prop-row">
        <label>Field of View: {fov}°</label>
        <input type="range" min={30} max={95} step={1} value={fov}
          onChange={(e) => onChange({ startAngle, endAngle, startPitch, endPitch, fov: Math.min(95, Math.max(30, Number(e.target.value))) })}
          className="slider" />
        <span className="prop-hint">Narrower = more zoom · 65-80° looks most natural</span>
      </div>

      <style>{`
        .pano-framer { display: flex; flex-direction: column; gap: 8px; }
        .framer-label { font-size: 10px; color: #666; }
        .pano-strip-wrapper {
          border-radius: 4px; overflow: hidden;
          border: 1px solid #2a2a4a; touch-action: none;
        }
        .pano-strip {
          position: relative; width: 100%; height: 100px;
          background: #000; overflow: hidden;
          user-select: none; touch-action: none;
        }
        @media (max-width: 768px) { .pano-strip { height: 120px; } }
        .pano-img {
          width: 100%; height: 100%; object-fit: cover;
          pointer-events: none; user-select: none;
        }
        .angle-grid { display: flex; align-items: flex-start; gap: 6px; justify-content: center; }
        .angle-group { display: flex; flex-direction: column; gap: 3px; }
        .angle-group-label { font-size: 9px; font-weight: 700; letter-spacing: 0.3px; }
        .angle-row { display: flex; align-items: center; gap: 3px; }
        .angle-row label { font-size: 9px; color: #666; width: 32px; }
        .angle-row input {
          width: 45px; background: #1a1a2e; border: 1px solid #2a2a4a;
          color: #ddd; padding: 2px 4px; border-radius: 3px;
          font-size: 10px; text-align: center;
        }
        .angle-row span { font-size: 9px; color: #555; }
        .angle-arrow { font-size: 14px; color: #444; padding-top: 14px; }
        .prop-row { display: flex; flex-direction: column; gap: 4px; }
        .prop-row label { font-size: 11px; color: #666; }
        .prop-hint { font-size: 9px; color: #444; }
        .slider { width: 100%; accent-color: #ff3366; }
      `}</style>
    </div>
  );
};

/**
 * DragHandle — fully self-contained drag with live updates.
 *
 * All event handlers are defined ONCE on mount (useCallback with [] deps).
 * They read everything from refs, so re-renders during drag don't break
 * the touch session.
 *
 * On touch start: record finger pos + strip size + initial angle/pitch from latest ref
 * On touch move: compute delta → new angle/pitch → call onChange from latest ref
 * On touch end: clear session
 */
type LatestRef = React.MutableRefObject<{
  startAngle: number;
  endAngle: number;
  startPitch: number;
  endPitch: number;
  fov: number;
  onChange: (u: { startAngle: number; endAngle: number; startPitch: number; endPitch: number; fov: number }) => void;
}>;

const DragHandle: React.FC<{
  xPct: number;
  yPct: number;
  color: string;
  label: string;
  angle: number;
  pitch: number;
  active: boolean;
  stripRef: React.RefObject<HTMLDivElement | null>;
  type: "start" | "end";
  latestRef: LatestRef;
  onActiveChange: (active: boolean) => void;
}> = ({ xPct, yPct, color, label, angle, pitch, active, stripRef, type, latestRef, onActiveChange }) => {
  const session = useRef<{
    startX: number;
    startY: number;
    stripW: number;
    stripH: number;
    initAngle: number;
    initPitch: number;
  } | null>(null);

  // Stable callbacks — no dependency on props, read everything from refs
  const beginDrag = useCallback((clientX: number, clientY: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    const rect = strip.getBoundingClientRect();
    const v = latestRef.current;
    session.current = {
      startX: clientX,
      startY: clientY,
      stripW: rect.width || 200,
      stripH: rect.height || 100,
      initAngle: type === "start" ? v.startAngle : v.endAngle,
      initPitch: type === "start" ? v.startPitch : v.endPitch,
    };
    onActiveChange(true);
  }, [stripRef, latestRef, type, onActiveChange]);

  const moveDrag = useCallback((clientX: number, clientY: number) => {
    const s = session.current;
    if (!s) return;
    const v = latestRef.current;

    const dx = clientX - s.startX;
    const dy = clientY - s.startY;
    const deltaYaw = (dx / s.stripW) * 360;
    const deltaPitch = -(dy / s.stripH) * 180;

    let newYaw = s.initAngle + deltaYaw;
    newYaw = ((newYaw % 360) + 360) % 360;
    let newPitch = Math.max(-85, Math.min(85, s.initPitch + deltaPitch));

    if (type === "start") {
      v.onChange({
        startAngle: Math.round(newYaw),
        endAngle: v.endAngle,
        startPitch: Math.round(newPitch),
        endPitch: v.endPitch,
        fov: v.fov,
      });
    } else {
      v.onChange({
        startAngle: v.startAngle,
        endAngle: Math.round(newYaw),
        startPitch: v.startPitch,
        endPitch: Math.round(newPitch),
        fov: v.fov,
      });
    }
  }, [latestRef, type]);

  const endDrag = useCallback(() => {
    session.current = null;
    onActiveChange(false);
  }, [onActiveChange]);

  // --- Touch (stable refs, attached once) ---
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const t = e.touches[0];
    beginDrag(t.clientX, t.clientY);
  }, [beginDrag]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!session.current) return;
    e.preventDefault();
    const t = e.touches[0];
    moveDrag(t.clientX, t.clientY);
  }, [moveDrag]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!session.current) return;
    e.preventDefault();
    endDrag();
  }, [endDrag]);

  // --- Mouse (document listeners on mousedown) ---
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    beginDrag(e.clientX, e.clientY);

    const onMove = (ev: MouseEvent) => {
      if (!session.current) return;
      ev.preventDefault();
      moveDrag(ev.clientX, ev.clientY);
    };
    const onUp = () => {
      endDrag();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [beginDrag, moveDrag, endDrag]);

  return (
    <div
      className="drag-handle"
      style={{ left: `${xPct}%`, top: `${yPct}%` }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onMouseDown={onMouseDown}
    >
      <div className="drag-dot" style={{
        background: color,
        transform: active ? "scale(1.4)" : "scale(1)",
      }} />
      <div className="drag-label" style={{ background: color }}>
        {label} {angle}°/{pitch}°
      </div>
      <style>{`
        .drag-handle {
          position: absolute;
          width: 44px; height: 44px;
          transform: translate(-50%, -50%);
          cursor: grab;
          z-index: 20;
          display: flex; align-items: center; justify-content: center;
          touch-action: none;
        }
        .drag-handle:active { cursor: grabbing; }
        .drag-dot {
          width: 14px; height: 14px;
          border-radius: 50%;
          border: 2px solid #fff;
          box-shadow: 0 1px 6px rgba(0,0,0,0.8);
          pointer-events: none;
          transition: transform 0.1s ease;
        }
        .drag-label {
          position: absolute;
          top: -16px;
          font-size: 7px; font-weight: 700;
          color: #fff; padding: 1px 4px;
          border-radius: 2px; white-space: nowrap;
          pointer-events: none; line-height: 1.4;
        }
      `}</style>
    </div>
  );
};

/** Non-interactive FOV rectangle */
const FovRect: React.FC<{
  xPct: number; yPct: number; fovXPct: number; fovYPct: number; color: string;
}> = ({ xPct, yPct, fovXPct, fovYPct, color }) => {
  const left = xPct - fovXPct / 2;
  const top = yPct - fovYPct / 2;
  return (
    <>
      <div style={{
        position: "absolute",
        left: `${left}%`, top: `${top}%`,
        width: `${fovXPct}%`, height: `${fovYPct}%`,
        border: `1px solid ${color}55`,
        background: `${color}15`,
        pointerEvents: "none", zIndex: 3,
      }} />
      {(left < 0 || left + fovXPct > 100) && (
        <div style={{
          position: "absolute",
          left: `${left < 0 ? left + 100 : left - 100}%`,
          top: `${top}%`,
          width: `${fovXPct}%`, height: `${fovYPct}%`,
          border: `1px solid ${color}33`,
          background: `${color}10`,
          pointerEvents: "none", zIndex: 3,
        }} />
      )}
    </>
  );
};

/** Dashed arrow showing pan direction */
const PanArrow: React.FC<{ fromX: number; fromY: number; toX: number; toY: number }> = ({
  fromX, fromY, toX, toY,
}) => {
  let dx = toX - fromX;
  if (dx > 50) dx -= 100;
  if (dx < -50) dx += 100;
  const dy = toY - fromY;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 2) return null;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  return (
    <div style={{
      position: "absolute",
      left: `${fromX}%`, top: `${fromY}%`,
      width: `${len}%`, height: 0,
      borderTop: "1px dashed rgba(255,255,255,0.3)",
      transformOrigin: "left center",
      transform: `rotate(${angle}deg)`,
      zIndex: 2, pointerEvents: "none",
    }} />
  );
};
