import React from "react";
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { accentEnvelope, clipSchema, framePlan, portalFootageBox, type Accent, type Clip, type Flare, type Portal, type Timeline } from "@reelwalk/core";
import { PersonMatteView } from "./PersonMatte";
import { clipPresentation } from "./presentation";
import type { ReelAsset } from "./types";

/**
 * Accents (ADR 0108): drawn over the footage and under the titles. Each is a pure function of its frame, so the
 * editor's Player and the export agree. A portal's person is the ordinary person matte (ADR 0039), of a silent second
 * playing of the take, drawn at the reel's size inside a box scaled into the card.
 */

function resolveSrc(src: string): string {
  return /^(https?:|blob:|data:)/.test(src) ? src : staticFile(src);
}

/** The shot under the accent's own frame moves it, when it follows the camera: the same transform as the footage. */
function useCameraTransform(timeline: Timeline, reelFrame: number, follow: boolean): string | undefined {
  const { fps } = useVideoConfig();
  if (!follow) return undefined;
  const plan = framePlan(timeline, fps);
  let at = 0;
  for (const [index, entry] of plan.clips.entries()) {
    if (reelFrame < at + entry.durationInFrames) return clipPresentation(entry.clip, reelFrame - at, fps, entry.durationInFrames, index === 0).transform;
    at += entry.durationInFrames;
  }
  return undefined;
}

const PortalView: React.FC<{ portal: Portal; timeline: Timeline; assets: Record<string, ReelAsset>; from: number; durationInFrames: number }> = ({ portal, timeline, assets, from, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const camera = useCameraTransform(timeline, from + frame, portal.followCamera);
  const asset = assets[portal.person.assetId];
  const wall = portal.wall.kind === "image" ? assets[portal.wall.assetId] : undefined;
  const { opacity, scale } = accentEnvelope(portal, ((from + frame) * 1000) / fps);
  // A clip of the take for the matte: its second playing, straight, with no move of its own (the card carries the move).
  const clip: Clip = React.useMemo(() => clipSchema.parse({
    id: `portal-${portal.id}`, assetId: portal.person.assetId, kind: "VIDEO",
    sourceStartMs: portal.person.sourceStartMs, sourceEndMs: portal.person.sourceStartMs + Math.max(1, Math.round((durationInFrames * 1000) / fps)),
  }), [portal.id, portal.person.assetId, portal.person.sourceStartMs, durationInFrames, fps]);
  const card = { width: portal.width * width, height: portal.height * height };
  const box = portalFootageBox(portal.person, card, { width, height });
  const glow = portal.glow * width;
  const edge = Math.max(2, width * 0.005);
  return (
    <AbsoluteFill data-accent="portal" style={{ pointerEvents: "none", transform: camera, opacity }}>
      <div style={{
        position: "absolute", left: portal.x * width - card.width / 2, top: portal.y * height - card.height / 2, width: card.width, height: card.height,
        transform: `perspective(${(width * 2).toFixed(0)}px) rotateY(${portal.yaw}deg) rotateZ(${portal.roll}deg) scale(${scale.toFixed(4)})`,
        boxShadow: `0 0 0 ${edge}px ${portal.edgeColor}, 0 0 ${(edge * 3).toFixed(1)}px ${edge}px ${portal.edgeColor}, 0 0 ${glow.toFixed(1)}px ${(glow * 0.35).toFixed(1)}px ${portal.glowColor}, 0 0 ${(glow * 2.6).toFixed(1)}px ${(glow * 0.7).toFixed(1)}px ${portal.glowColor}aa`,
      }}>
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: portal.wall.kind === "gradient" ? `linear-gradient(${portal.wall.angle ?? 180}deg, ${portal.wall.colors.join(", ")})` : "#222" }}>
          {wall?.kind === "IMAGE" ? <Img src={resolveSrc(wall.src)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} /> : null}
          {asset ? (
            <div style={{ position: "absolute", left: 0, top: 0, width, height, transformOrigin: "0 0", transform: `translate(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px) scale(${box.scale.toFixed(5)})${portal.person.mirror ? ` translateX(${width}px) scaleX(-1)` : ""}` }}>
              <PersonMatteView clip={clip} asset={asset} durationInFrames={durationInFrames} />
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** A warm bloom with a tighter core and a soft streak, screened over the picture, breathing slowly so it does not sit like a sticker. */
const FlareView: React.FC<{ flare: Flare; timeline: Timeline; from: number }> = ({ flare, timeline, from }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const camera = useCameraTransform(timeline, from + frame, flare.followCamera);
  const reelMs = ((from + frame) * 1000) / fps;
  const { opacity } = accentEnvelope(flare, reelMs);
  const breathe = 1 + 0.06 * Math.sin(reelMs / 420);
  const r = flare.size * width * breathe;
  const cx = flare.x * width, cy = flare.y * height;
  const spot = (radius: number, inner: string, stop: number): React.CSSProperties => ({ position: "absolute", left: cx - radius, top: cy - radius, width: radius * 2, height: radius * 2, borderRadius: "50%", background: `radial-gradient(circle, ${inner} 0%, ${flare.color}00 ${stop}%)` });
  return (
    <AbsoluteFill data-accent="flare" style={{ pointerEvents: "none", mixBlendMode: "screen", transform: camera, opacity: opacity * flare.intensity }}>
      <div style={spot(r, `${flare.color}d0`, 70)} />
      <div style={spot(r * 0.34, "#fff4dcf0", 62)} />
      <div style={{ position: "absolute", left: cx - r * 1.5, top: cy - r * 0.035, width: r * 3, height: r * 0.07, borderRadius: "50%", background: `radial-gradient(ellipse, #fff0d460 0%, ${flare.color}30 45%, ${flare.color}00 72%)` }} />
    </AbsoluteFill>
  );
};

export const AccentsView: React.FC<{ timeline: Timeline; assets: Record<string, ReelAsset> }> = ({ timeline, assets }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {(timeline.accents ?? []).map((accent: Accent) => {
        const from = Math.round((accent.startMs * fps) / 1000);
        const durationInFrames = Math.max(1, Math.round(((accent.endMs - accent.startMs) * fps) / 1000));
        return (
          <Sequence key={accent.id} from={from} durationInFrames={durationInFrames} name={`accent ${accent.id}`}>
            {accent.kind === "portal"
              ? <PortalView portal={accent} timeline={timeline} assets={assets} from={from} durationInFrames={durationInFrames} />
              : <FlareView flare={accent} timeline={timeline} from={from} />}
          </Sequence>
        );
      })}
    </>
  );
};
