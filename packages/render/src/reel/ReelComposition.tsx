import React from "react";
import {
  AbsoluteFill,
  Audio,
  Html5Video,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useRemotionEnvironment,
  useVideoConfig,
} from "remotion";
// WebCodecs-based video, used when the worker renders: about twice as fast as
// OffthreadVideo here, and it falls back to it for files it cannot decode.
import { Video as RenderVideo } from "@remotion/media";
import { cameraAt, homography, invertHomography, matrix3d, oneLineWidth, PINNED_ELSEWHERE, pinnedProgress, planarFitAndShift, textPositionAt, textQuadAt, duckGain, framePlan, INSTAGRAM, isInstagramMusic, speechWindows, REEL_FORMAT, timelineDurationMs, walkInto, type Clip, type Logo, type Plan, type TextOverlay, type Timeline, endsBeforeShot, orientOrder, orientQuad } from "@reelwalk/core";
import { whipGeometry } from "./whip";
import { clipPresentation } from "./presentation";
import { useFontsFor } from "./fonts";
import { ELEGANT_FADE_S, FILTER_CSS, textTreatmentCss } from "./look";
import { DetailsCardView } from "./DetailsCardView";
import { PanoView } from "./PanoView";
import { PlanOverlayView } from "./PlanOverlayView";
import type { ReelAsset, ReelProps } from "./types";
import { Watermark } from "./Watermark";
import { PersonMatteView } from "./PersonMatte";
import { ObjectMatteView } from "./ObjectMatte";
import { HookView } from "./HookView";

const WhipBlur: React.FC<{ id: string; amount: number; direction: Clip["whipDirection"] }> = ({ id, amount, direction }) => {
  const g = whipGeometry(amount, direction);
  return <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
    <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation={`${g.blurX} ${g.blurY}`} edgeMode="duplicate" />
    </filter>
  </svg>;
};


function resolveSrc(src: string): string {
  return /^(https?:|blob:|data:)/.test(src) ? src : staticFile(src);
}


const Media: React.FC<{
  clip: Clip;
  asset: ReelAsset;
  fit: "cover" | "contain";
  muted?: boolean;
  transform?: string;
}> = ({ clip, asset, fit, muted, transform }) => {
  const { fps } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: fit,
    transform,
    filter: FILTER_CSS[clip.filter],
  };
  if (asset.kind === "IMAGE") return <Img src={resolveSrc(asset.src)} style={style} />;
  const toFrame = (ms: number) => Math.round((ms * fps) / 1000);
  const timing = {
    src: resolveSrc(asset.src),
    trimBefore: toFrame(clip.sourceStartMs),
    trimAfter: toFrame(clip.sourceEndMs),
    playbackRate: clip.speed,
    volume: muted ? 0 : clip.volume,
    muted: muted || clip.volume === 0,
  };
  if (!isRendering) {
    // In the editor's preview a plain <video> element plays best on phones:
    // hardware decoding, and it works the same in iOS Safari.
    return <Html5Video {...timing} style={style} />;
  }
  return (
    <RenderVideo
      {...timing}
      objectFit={fit}
      style={{ ...style, objectFit: undefined }}
    />
  );
};

const ClipView: React.FC<{
  clip: Clip;
  asset: ReelAsset | undefined;
  durationInFrames: number;
  fadeOut: boolean;
  /** The next clip whips in, so this one whips out. */
  whipOut?: Clip["whipDirection"] | null;
  /** The clip before this one and its media, for a walk between two 360 photos. */
  previous?: { clip: Clip; asset: ReelAsset | undefined };
  plan: Plan | null;
}> = ({ clip, asset, durationInFrames, fadeOut, whipOut = null, previous, plan }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!asset) {
    // The source was deleted. Show a neutral frame instead of failing the whole render.
    return <AbsoluteFill style={{ backgroundColor: "#262320" }} />;
  }

  // Clamped: a clip is mounted a second early (premount) with negative frames.
  const progress = durationInFrames > 1 ? Math.min(1, Math.max(0, frame / (durationInFrames - 1))) : 0;
  const { transform, opacity: shown, whip, whipAmount, whipId, whipDirection } = clipPresentation(clip, frame, fps, durationInFrames, fadeOut, whipOut);

  if (clip.pano && asset.kind === "IMAGE") {
    const clipMs = (durationInFrames * 1000) / fps;
    // A walk needs the photo the camera is leaving; without it the clip simply cuts in.
    const from = previous?.asset?.kind === "IMAGE" && walkInto(plan, previous.clip, clip, clipMs) ? previous : undefined;
    const camera = from
      ? cameraAt(plan, from.clip, clip, (Math.max(0, frame) * 1000) / fps, clipMs)
      : cameraAt(plan, undefined, clip, progress, 1);
    return (
      <AbsoluteFill style={{ opacity: shown, backgroundColor: "#000", ...whip }}>
        {whip ? <WhipBlur id={whipId} amount={whipAmount} direction={whipDirection} /> : null}
        <PanoView
          src={resolveSrc(asset.src)}
          spot={clip.spot}
          from={from?.clip.spot && from.asset ? { src: resolveSrc(from.asset.src), spot: from.clip.spot } : null}
          camera={camera}
          planAspect={plan?.aspect ?? 1}
          style={{ filter: FILTER_CSS[clip.filter] }}
        />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ opacity: shown, overflow: "hidden" }}>
      {whip ? <WhipBlur id={whipId} amount={whipAmount} direction={whipDirection} /> : null}
      <AbsoluteFill style={whip}>
      {clip.fit === "contain" ? (
        // Letterboxed: the same picture, blurred and enlarged, fills the 9:16 frame behind it.
        <AbsoluteFill style={{ filter: "blur(48px) brightness(0.7)", transform: "scale(1.25)" }}>
          <Media clip={clip} asset={asset} fit="cover" muted />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill>
        <Media clip={clip} asset={asset} fit={clip.fit} transform={transform} />
      </AbsoluteFill>
      {clip.lensSoftness ? <AbsoluteFill style={{ pointerEvents: "none", backdropFilter: `blur(${clip.lensSoftness * 7}px)`,
        maskImage: "radial-gradient(ellipse 47% 40% at 50% 48%, transparent 52%, black 100%)",
        WebkitMaskImage: "radial-gradient(ellipse 47% 40% at 50% 48%, transparent 52%, black 100%)" }} /> : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Seconds the typewriter takes to write the whole text: a short line in about a second, never more than half the text's time. */
const TYPE_CHARS_PER_S = 14;

/**
 * How a text arrives: scale, opacity, a vertical drift and, for the
 * typewriter, how many characters are written yet. "auto" is the style's own
 * way in: the slow fade of the elegant serif, a pop for everything else.
 */
function textMotion(text: TextOverlay, frame: number, fps: number, durationInFrames: number): { scale: number; opacity: number; rise: number; chars: number | null } {
  const animation = text.animation === "auto" ? (text.style === "elegant" ? "fade" : "pop") : text.animation;
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const still = { scale: 1, opacity: 1, rise: 0, chars: null };
  switch (animation) {
    case "fade": {
      // A slow fade in and out, no movement: the words settle onto the picture.
      const fade = Math.max(1, Math.min(Math.round(ELEGANT_FADE_S * fps), Math.floor(durationInFrames / 2)));
      const fadeIn = interpolate(frame, [0, fade], [0, 1], clamp);
      const fadeOut = interpolate(frame, [durationInFrames - fade, durationInFrames], [1, 0], clamp);
      return { ...still, opacity: Math.min(fadeIn, fadeOut) };
    }
    case "rise": {
      const rise = Math.max(1, Math.min(Math.round(0.5 * fps), Math.floor(durationInFrames / 2)));
      return { ...still, opacity: interpolate(frame, [0, rise], [0, 1], clamp), rise: interpolate(frame, [0, rise], [1, 0], clamp) };
    }
    case "type": {
      const length = text.text.length;
      const seconds = Math.min(length / TYPE_CHARS_PER_S, durationInFrames / fps / 2);
      const chars = Math.min(length, Math.ceil(interpolate(frame, [0, Math.max(1, seconds * fps)], [0, length], clamp)));
      return { ...still, chars };
    }
    case "none":
      return still;
    default: {
      // A short pop on entry, the way Instagram animates text in.
      const pop = spring({ frame, fps, config: { damping: 14, stiffness: 180 }, durationInFrames: 10 });
      return { ...still, scale: interpolate(pop, [0, 1], [0.86, 1]), opacity: interpolate(frame, [0, 3], [0, 1], { extrapolateRight: "clamp" }) };
    }
  }
}

/** A stack of offset shadows that reads as extruded type, darker as it recedes, with a soft ground shadow. The depth scales with the type: about a fifth of the cap height. */
function extrudedShadow(color: string, fontSize: number): string {
  const step = Math.max(1, fontSize * 0.014);
  const layers: string[] = [];
  for (let i = 1; i <= 14; i++) layers.push(`${(i * step * 0.8).toFixed(1)}px ${(i * step).toFixed(1)}px 0 rgba(0,0,0,${(0.5 + i * 0.025).toFixed(2)})`);
  layers.push(`${(step * 16).toFixed(0)}px ${(step * 22).toFixed(0)}px ${(step * 20).toFixed(0)}px rgba(0,0,0,0.45)`);
  return `${layers.join(", ")}, 0 0 1px ${color}`;
}

const TextView: React.FC<{ text: TextOverlay; durationInFrames: number; timeline: Timeline; from: number }> = ({ text, durationInFrames, timeline, from }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const css = textTreatmentCss(text);
  // A pinned path runs on its clip's source time (ADR 0039); a drift runs over the text's own life.
  const progress = text.pin ? pinnedProgress(timeline, text, ((from + frame) * 1000) / fps) : durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;
  const position = textPositionAt(text, progress);
  // A title with a surface but no pin yet is drawn inside its surface as it stands (ADR 0044): the corners
  // being dragged reshape the words at once, and pinning then makes that plane follow the camera.
  const bare = text.surface && !text.pin ? orientQuad(text.surface) : null;
  // A pinned plane keeps the order its corners were placed in, as do its keyframes; both are re-ordered
  // the same way so a title pinned from a mirrored placement still reads upright.
  const order = text.pin?.quad ? orientOrder(text.pin.quad) : null;
  const reorder = (q: number[] | null): number[] | null => (q && order ? order.flatMap((i) => [q[i * 2], q[i * 2 + 1]]) : q);
  const quad = reorder(textQuadAt(text, progress)) ?? bare;
  const plane = (text.pin?.quad ? reorder(text.pin.quad) : bare) ?? undefined;
  // A pinned title belongs to its shot: while another clip is on screen it is not drawn at all.
  // Hooks first: a pinned title on another clip returns nothing, but only after every hook has run (React 300 otherwise).
  useFontsFor(text.text, Number(css.fontWeight ?? 600));
  const { scale, opacity, rise, chars } = textMotion(text, frame, fps, durationInFrames);
  if (text.pin && progress === PINNED_ELSEWHERE) return null;
  const face = { ...css, ...(text.depth === "extruded" ? { textShadow: extrudedShadow(text.color, Number(css.fontSize) || 64), WebkitTextStroke: `${Math.max(0.5, (Number(css.fontSize) || 64) * 0.01)}px rgba(0,0,0,0.35)` } : {}) };
  // Paint on the surface: hard-light keeps the wall's own light and grain through the letters (white lightens, dark darkens), with the footage's softness.
  // A tracked title fades where the tracker lost the surface (or where its path says so), instead of cutting;
  // one taken off before its shot ends (ADR 0044) fades over its last 0.4 s rather than vanishing mid-shot.
  const tail = text.pin && endsBeforeShot(timeline, text) ? interpolate(frame, [Math.max(0, durationInFrames - Math.round(0.4 * fps)), durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const visible = opacity * position.opacity * tail;
  // The typewriter keeps the full text in place, invisible, so the box never changes size while it writes.
  const written = chars === null ? text.text : text.text.slice(0, chars);
  const cursor = chars !== null && chars < text.text.length && Math.floor(frame / (fps / 4)) % 2 === 0;
  // The blend's own 0.92 multiplies the fade; spread after `opacity`, a flat 0.92 used to cancel it.
  const meet = text.blend === "surface" ? { mixBlendMode: "hard-light" as const, filter: "blur(0.6px)", opacity: visible * 0.92 } : {};
  if (quad && plane) {
    // A planar title never wraps, so a long one is shrunk to fit the frame rather than running off it.
    // The widest of the typed lines sets the width.
    const line = Math.max(...text.text.split("\n").map((part) => oneLineWidth(part || " ", { fontFamily: String(css.fontFamily ?? ""), fontWeight: css.fontWeight, fontSize: Number(css.fontSize) || 64, letterSpacing: text.tracking, fontStretch: css.fontStretch ? String(css.fontStretch) : undefined }, width)));
    // The plane's own rectangle: as wide as the average of its top and bottom edges and as tall as the
    // average of its sides, in pixels. One edge alone (the top for width, the left for height) made a
    // title grow to fill a long top edge and then warp thin onto a short bottom one as a corner was dragged.
    const px = (i: number) => plane[i * 2] * width, py = (i: number) => plane[i * 2 + 1] * height;
    const edge = (a: number, b: number) => Math.hypot(px(b) - px(a), py(b) - py(a));
    const w = Math.max(1, (edge(0, 1) + edge(3, 2)) / 2), h = Math.max(1, (edge(0, 3) + edge(1, 2)) / 2);
    const rectWidth = Math.max(0.05, w / width);
    const rectHeight = Math.max(0.02, h / height);
    // The block the author typed: one line, or the lines they broke it into (each as tall as a line).
    const lines = text.text.split("\n").length;
    const lineHeight = (((Number(css.fontSize) || 64) * 1.12) / height) * lines;
    // A title on a chosen surface fills it: scaled up or down to span 94% of its width, as long as it fits its height.
    const fit = text.surface ? Math.min((rectWidth * 0.94) / line, (rectHeight * 0.92) / lineHeight) : planarFitAndShift(plane, line).fit;
    // The text sits on the plane the tracker followed: a box at the pinned corners, warped to where they are now (ADR 0039).
    const q0 = plane;
    const left = q0[0] * width, top = q0[1] * height;
    const now = quad.map((v, i) => (i % 2 === 0 ? v * width - left : v * height - top)) as [number, number, number, number, number, number, number, number];
    const H = homography([0, 0, w, 0, w, h, 0, h], now);
    // Bars (a mullion, a post) in front of the surface: holes cut in the plane's own coordinates, so they warp with it.
    let mask: React.CSSProperties = {};
    if (text.surface && (text.bars?.length || text.cutouts?.length)) {
      const H0 = homography([0, 0, w, 0, w, h, 0, h], q0.map((v, i) => (i % 2 === 0 ? v * width - left : v * height - top)) as [number, number, number, number, number, number, number, number]);
      const inv = H0 ? invertHomography(H0) : null;
      if (inv) {
        // The posts are cut out of the plane in the plane's own coordinates, so they warp with it. A mask
        // (white plane, black posts) subtracts their union: an even-odd path put two overlapping posts
        // back to visible where they crossed, and two identical posts cancelled each other.
        const toRect = (x: number, y: number) => { const px = x * width - left, py = y * height - top; const d = inv[6] * px + inv[7] * py + inv[8] || 1e-9; return `${((inv[0] * px + inv[1] * py + inv[2]) / d).toFixed(1)},${((inv[3] * px + inv[4] * py + inv[5]) / d).toFixed(1)}`; };
        const shapes = [...(text.bars ?? []), ...(text.cutouts ?? [])];
        const posts = shapes.map((shape) => `<polygon points="${Array.from({ length: shape.length / 2 }, (_, i) => toRect(shape[i * 2], shape[i * 2 + 1])).join(" ")}" fill="black"/>`).join("");
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="white"/>${posts}</svg>`;
        const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
        // Luminance, not the default alpha: an image mask reads alpha unless told otherwise, and a black
        // polygon is as opaque as the white plane, so nothing would be cut (found on the phone, 2026-10-20).
        mask = { maskImage: url, WebkitMaskImage: url, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskMode: "luminance" };
      }
    }
    return (
      <AbsoluteFill style={{ pointerEvents: "none", perspective: "none" }}>
        {/* Painted on a chosen surface, the text exists only on that surface: anything in front of the surface's edge (a wall, a railing) hides it. */}
        <div style={{ position: "absolute", left, top, width: w, height: h, display: "flex", alignItems: "center", justifyContent: "center", transformOrigin: "0 0", transform: H ? matrix3d(H) : undefined, opacity: visible, whiteSpace: "nowrap", textAlign: "center", overflow: text.surface ? "hidden" : "visible", ...mask, ...meet }}>
          {/* The tracked box is only the plane's frame, narrower than most titles: the words sit on one line (or the lines the author typed) and overflow it, warped with it. */}
          <span style={{ ...face, position: "relative", whiteSpace: text.text.includes("\n") ? "pre" : "nowrap", overflowWrap: "normal", wordBreak: "keep-all", transform: `scale(${scale * fit})` }}>
            {chars === null ? text.text : (<>
              {/* The typewriter on a plane: the full text holds the size, the written part sits over it. */}
              <span style={{ visibility: "hidden" }}>{text.text}</span>
              <span style={{ position: "absolute", inset: 0, textAlign: "inherit" }}>{written}{cursor ? "|" : ""}</span>
            </>)}
          </span>
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: position.x * width,
          top: position.y * height,
          // A single word never breaks mid-word (a tracked title is usually one word); sentences wrap inside the safe width.
          ...(/\s/.test(text.text) ? { width: width * 0.86 } : { width: "max-content", maxWidth: width * 1.4, whiteSpace: "nowrap" as const }),
          display: "flex",
          justifyContent: "center",
          transform: `translate(-50%, calc(-50% + ${rise * 40}px)) scale(${scale * position.scale}) rotate(${position.rotation}deg)`,
          opacity: visible,
          ...meet,
        }}
      >
        {chars === null ? (
          <span style={face}>{text.text}</span>
        ) : (
          <span style={{ ...css, position: "relative" }}>
            <span style={{ visibility: "hidden" }}>{text.text}</span>
            {/* The same box as the hidden text (its padding, when the style has one), so the words wrap the same way. */}
            <span style={{ position: "absolute", inset: css.padding ?? 0, textAlign: "inherit" }}>
              {written}
              {cursor ? "|" : ""}
            </span>
          </span>
        )}
      </div>
    </AbsoluteFill>
  );
};

/** A logo kept in one corner of the safe area for the whole reel, with a soft shadow so it holds on any picture. */
const LogoView: React.FC<{ logo: Logo; asset: ReelAsset | undefined }> = ({ logo, asset }) => {
  const { width } = useVideoConfig();
  if (!asset || asset.kind !== "IMAGE") return null;
  const safe = INSTAGRAM.safeZonePx;
  const [vertical, horizontal] = logo.corner.split("-") as ["top" | "bottom", "left" | "right"];
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <Img
        src={resolveSrc(asset.src)}
        style={{
          position: "absolute",
          [vertical]: vertical === "top" ? safe.top : safe.bottom + 16,
          [horizontal]: horizontal === "left" ? safe.left : safe.right,
          width: width * logo.size,
          maxHeight: width * logo.size,
          objectFit: "contain",
          objectPosition: `${horizontal} ${vertical}`,
          filter: "drop-shadow(0 4px 16px rgba(0, 0, 0, 0.45))",
        }}
      />
    </AbsoluteFill>
  );
};

const MusicTrack: React.FC<{ timeline: Timeline; asset: ReelAsset; assets: Record<string, ReelAsset> }> = ({ timeline, asset, assets }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const music = timeline.music!;
  // Dips under speech come from the transcripts, so they follow every edit (ADR 0035).
  const speech = React.useMemo(() => speechWindows(timeline, Object.fromEntries(Object.entries(assets).map(([id, entry]) => [id, entry.transcript]))), [timeline, assets]);
  const fadeFrames = Math.min(fps, Math.floor(durationInFrames / 3));
  return (
    <Audio
      src={resolveSrc(asset.src)}
      trimBefore={Math.round((music.sourceStartMs * fps) / 1000)}
      // An Instagram sound (editor preview only, ADR 0019) plays once from its
      // start, as Instagram will; your own song loops under a longer reel.
      loop={!isInstagramMusic(music)}
      // Fade out over the last second so the reel does not end mid-note.
      volume={(frame) =>
        music.volume *
        duckGain(speech, (frame * 1000) / fps) *
        interpolate(frame, [durationInFrames - fadeFrames, durationInFrames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      }
    />
  );
};

/**
 * The whole reel. Used by the Player in the editor and by the worker for the
 * final MP4, so the export always matches the preview.
 */
export const ReelComposition: React.FC<ReelProps> = ({ timeline, assets, watermark = false }) => {
  const { fps } = useVideoConfig();
  const plan = framePlan(timeline, fps);
  const musicAsset = timeline.music ? assets[timeline.music.assetId] : undefined;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {plan.clips.map(({ clip, from, durationInFrames }, index) => (
        // premountFor loads the next clip a second early, so the preview does not stall at cuts.
        <Sequence key={clip.id} from={from} durationInFrames={durationInFrames} premountFor={fps} name={`clip ${index + 1}`}>
          <ClipView
            clip={clip}
            asset={assets[clip.assetId]}
            durationInFrames={durationInFrames}
            fadeOut={timeline.clips[index + 1]?.transitionIn === "fade"}
            whipOut={timeline.clips[index + 1]?.transitionIn === "whip" ? timeline.clips[index + 1].whipDirection ?? "right" : null}
            previous={index > 0 ? { clip: timeline.clips[index - 1], asset: assets[timeline.clips[index - 1].assetId] } : undefined}
            plan={timeline.plan?.geometry ?? null}
          />
        </Sequence>
      ))}
      <PlanOverlayView timeline={timeline} />
      {plan.texts.map(({ text, from, durationInFrames }) => (
        <Sequence key={text.id} from={from} durationInFrames={durationInFrames} name={`text ${text.text.slice(0, 12)}`}>
          <TextView text={text} durationInFrames={durationInFrames} timeline={timeline} from={from} />
        </Sequence>
      ))}
      {/* People in front of the type (ADR 0039): a person-only matte of each clip a "behind" text overlaps, above the text layer. */}
      {plan.clips.map(({ clip, from, durationInFrames }) => {
        const asset = assets[clip.assetId];
        const startMs = (from * 1000) / fps, endMs = ((from + durationInFrames) * 1000) / fps;
        if (!asset || asset.kind !== "VIDEO" || !timeline.texts.some(text => text.behind && text.startMs < endMs && text.endMs > startMs)) return null;
        const index = timeline.clips.indexOf(clip);
        return (
          <Sequence key={`matte-${clip.id}`} from={from} durationInFrames={durationInFrames} name={`matte ${clip.id}`}>
            <PersonMatteView clip={clip} asset={asset} durationInFrames={durationInFrames}
              fadeOut={timeline.clips[index + 1]?.transitionIn === "fade"}
              whipOut={timeline.clips[index + 1]?.transitionIn === "whip" ? timeline.clips[index + 1].whipDirection ?? "right" : null} />
          </Sequence>
        );
      })}
      {/* Things tapped as being in front of a title (ADR 0044): the object under the tap, above the text layer. */}
      {plan.clips.flatMap(({ clip, from, durationInFrames }) => {
        const asset = assets[clip.assetId];
        if (!asset || asset.kind !== "VIDEO") return [];
        const startMs = (from * 1000) / fps, endMs = ((from + durationInFrames) * 1000) / fps;
        const index = timeline.clips.indexOf(clip);
        return timeline.texts.filter((text) => text.occluders?.length && text.startMs < endMs && text.endMs > startMs).map((text) => (
          <Sequence key={`object-${clip.id}-${text.id}`} from={from} durationInFrames={durationInFrames} name={`in front of ${text.text.slice(0, 12)}`}>
            <ObjectMatteView clip={clip} asset={asset} text={text} timeline={timeline} from={from} durationInFrames={durationInFrames}
              fadeOut={timeline.clips[index + 1]?.transitionIn === "fade"}
              whipOut={timeline.clips[index + 1]?.transitionIn === "whip" ? timeline.clips[index + 1].whipDirection ?? "right" : null} />
          </Sequence>
        ));
      })}
      {timeline.hook && plan.clips[0] ? <HookView timeline={timeline} hook={timeline.hook} firstClip={plan.clips[0].clip} asset={assets[plan.clips[0].clip.assetId]} /> : null}
      <DetailsCardView timeline={timeline} />
      {timeline.logo ? <LogoView logo={timeline.logo} asset={assets[timeline.logo.assetId]} /> : null}
      {watermark ? <Watermark /> : null}
      {musicAsset ? <MusicTrack timeline={timeline} asset={musicAsset} assets={assets} /> : null}

    </AbsoluteFill>
  );
};

export function reelDurationInFrames(timeline: Timeline, fps: number = REEL_FORMAT.fps): number {
  return Math.max(1, Math.round((timelineDurationMs(timeline) * fps) / 1000));
}

