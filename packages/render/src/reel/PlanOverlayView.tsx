import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { framePlan, INSTAGRAM, panoYawAt, roomIndexAt, type Spot, type Timeline } from "@reelwalk/core";

/** Longest side of the plan drawing, in frame pixels (the frame is 1080 wide). */
const PLAN_SIZE = 360;
const PADDING = 22;
/** Frames the marker takes to travel from the previous shot's position. */
const TRAVEL_FRAMES = 14;
/** Width of the view cone, roughly what the 9:16 frame sees. */
const CONE_DEGREES = 62;
const CONE_LENGTH = 54;

const COLORS = { card: "rgba(11, 32, 54, 0.82)", wall: "#eaf2fb", here: "#f0442c", seen: "rgba(234, 242, 251, 0.16)" };

const ease = (t: number) => t * t * (3 - 2 * t);

/** A wedge from the marker, pointing `degrees` clockwise from the top of the plan. */
function conePath(x: number, y: number, degrees: number): string {
  const point = (offset: number) => {
    const angle = ((degrees + offset - 90) * Math.PI) / 180;
    return `${x + Math.cos(angle) * CONE_LENGTH},${y + Math.sin(angle) * CONE_LENGTH}`;
  };
  return `M${x},${y} L${point(-CONE_DEGREES / 2)} A${CONE_LENGTH},${CONE_LENGTH} 0 0 1 ${point(CONE_DEGREES / 2)} Z`;
}

/**
 * The floor plan with a "you are here" marker. The marker jumps to where each
 * clip was shot, the room it is in lights up, and for 360 clips the view cone
 * turns with the camera.
 */
export const PlanOverlayView: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const overlay = timeline.plan;
  if (!overlay || !overlay.visible) return null;

  const plan = overlay.geometry;
  const drawWidth = plan.aspect >= 1 ? PLAN_SIZE : PLAN_SIZE * plan.aspect;
  const drawHeight = plan.aspect >= 1 ? PLAN_SIZE / plan.aspect : PLAN_SIZE;
  const px = (point: readonly [number, number]) => `${point[0] * drawWidth},${point[1] * drawHeight}`;

  // Which clip is on screen, and the last clip before it with a known position.
  const clips = framePlan(timeline, fps).clips;
  let current = clips.findIndex((entry) => frame >= entry.from && frame < entry.from + entry.durationInFrames);
  if (current === -1) current = clips.length - 1;
  const located = (index: number): { spot: Spot; index: number } | null => {
    for (let i = index; i >= 0; i--) {
      const spot = clips[i]?.clip.spot;
      if (spot) return { spot, index: i };
    }
    return null;
  };
  const here = located(current);
  const before = here && here.index === current ? located(current - 1) : null;

  const visited = new Set<number>();
  for (let i = 0; i <= current; i++) {
    const spot = clips[i]?.clip.spot;
    if (spot) visited.add(roomIndexAt(plan, spot));
  }

  let marker: { x: number; y: number; heading: number } | null = null;
  if (here) {
    const entry = clips[here.index];
    const local = frame - entry.from;
    const progress = entry.durationInFrames > 1 ? Math.min(1, Math.max(0, local / (entry.durationInFrames - 1))) : 0;
    const yaw = here.index === current && entry.clip.pano ? panoYawAt(entry.clip.pano, progress) : 0;
    const travel = before ? ease(interpolate(local, [0, TRAVEL_FRAMES], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })) : 1;
    const from = before?.spot ?? here.spot;
    marker = {
      x: (from.x + (here.spot.x - from.x) * travel) * drawWidth,
      y: (from.y + (here.spot.y - from.y) * travel) * drawHeight,
      heading: here.spot.heading + yaw,
    };
  }
  const hereRoom = here ? roomIndexAt(plan, here.spot) : -1;

  const cardWidth = drawWidth + PADDING * 2;
  const left = overlay.corner === "top-left" ? INSTAGRAM.safeZonePx.left : width - INSTAGRAM.safeZonePx.right - cardWidth;

  return (
    <div
      style={{
        position: "absolute",
        left,
        top: INSTAGRAM.safeZonePx.top + 20,
        padding: PADDING,
        borderRadius: 26,
        backgroundColor: COLORS.card,
      }}
    >
      <svg width={drawWidth} height={drawHeight} viewBox={`0 0 ${drawWidth} ${drawHeight}`} style={{ display: "block", overflow: "visible" }}>
        {plan.rooms.map((room, index) => (
          <polygon
            key={index}
            points={room.points.map(px).join(" ")}
            fill={index === hereRoom ? COLORS.here : visited.has(index) ? COLORS.seen : "none"}
            fillOpacity={index === hereRoom ? 0.42 : 1}
            stroke={COLORS.wall}
            strokeWidth={3}
            strokeLinejoin="round"
          />
        ))}
        {/* Doors: short gaps cut into the walls. */}
        {plan.doors.map(([a, b], index) => (
          <line key={index} x1={a[0] * drawWidth} y1={a[1] * drawHeight} x2={b[0] * drawWidth} y2={b[1] * drawHeight} stroke="#0b2036" strokeWidth={5} />
        ))}
        {marker ? (
          <>
            <path d={conePath(marker.x, marker.y, marker.heading)} fill={COLORS.here} fillOpacity={0.55} />
            <circle cx={marker.x} cy={marker.y} r={11} fill={COLORS.here} stroke="#fff" strokeWidth={4} />
          </>
        ) : null}
      </svg>
    </div>
  );
};
