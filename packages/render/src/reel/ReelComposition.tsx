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
import { cameraAt, cameraMoveAt, pinnedProgress, textPositionAt, duckGain, framePlan, INSTAGRAM, isInstagramMusic, speechWindows, REEL_FORMAT, timelineDurationMs, walkInto, type Clip, type Logo, type Plan, type TextOverlay, type Timeline } from "@reelwalk/core";
import { whipGeometry } from "./whip";
import { useFontsFor } from "./fonts";
import { ELEGANT_FADE_S, FILTER_CSS, textTreatmentCss } from "./look";
import { DetailsCardView } from "./DetailsCardView";
import { PanoView } from "./PanoView";
import { PlanOverlayView } from "./PlanOverlayView";
import type { ReelAsset, ReelProps } from "./types";
import { Watermark } from "./Watermark";
import { PersonMatteView } from "./PersonMatte";

/** Frames of the dip-to-black on each side of a "fade" transition. */
const FADE_FRAMES = 8;
/** Four silent frames on either side of a deliberate camera-matched whip. */
const WHIP_FRAMES = 4;
function whipStyle(amount: number, filterId: string, direction: Clip["whipDirection"]): React.CSSProperties | undefined {
  if (amount === 0) return undefined;
  const g = whipGeometry(amount, direction);
  return { transform: `translate(${g.x}%, ${g.y}%) scale(${g.scaleX}, ${g.scaleY})`, filter: `url(#${filterId})` };
}
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

/** The Ken Burns move and the clip's own zoom, as one CSS transform about the centre. */
function motionTransform(motion: Clip["motion"], progress: number, zoom: number, seconds: number): string | undefined {
  const move = cameraMoveAt(motion, progress, seconds);
  return zoom === 1 && move.scale === 1 && move.x === 0 ? undefined : `scale(${zoom * move.scale}) translateX(${move.x}%)`;
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
  const transform = motionTransform(clip.motion, progress, clip.zoom, Math.max(0, frame / fps));
  const fadeIn = clip.transitionIn === "fade" ? interpolate(frame, [0, FADE_FRAMES], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const fadeOutValue = fadeOut
    ? interpolate(frame, [durationInFrames - FADE_FRAMES, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const whipIn = clip.transitionIn === "whip" ? interpolate(frame, [0, WHIP_FRAMES], [1, 0], clamp) : 0;
  const whipAway = whipOut ? interpolate(frame, [durationInFrames - WHIP_FRAMES, durationInFrames - 1], [0, -1], clamp) : 0;
  const whipAmount = whipIn || whipAway;
  const whipId = `whip-${clip.id}`;
  const whipDirection = whipIn ? clip.whipDirection : whipOut ?? undefined;
  const whip = whipStyle(whipAmount, whipId, whipDirection);

  if (clip.pano && asset.kind === "IMAGE") {
    const clipMs = (durationInFrames * 1000) / fps;
    // A walk needs the photo the camera is leaving; without it the clip simply cuts in.
    const from = previous?.asset?.kind === "IMAGE" && walkInto(plan, previous.clip, clip, clipMs) ? previous : undefined;
    const camera = from
      ? cameraAt(plan, from.clip, clip, (Math.max(0, frame) * 1000) / fps, clipMs)
      : cameraAt(plan, undefined, clip, progress, 1);
    return (
      <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOutValue), backgroundColor: "#000", ...whip }}>
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
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOutValue), overflow: "hidden" }}>
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

/** A stack of offset shadows that reads as extruded type, darker as it recedes, with a soft ground shadow. */
function extrudedShadow(color: string): string {
  const layers: string[] = [];
  for (let i = 1; i <= 14; i++) layers.push(`${i * 0.9}px ${i * 1.1}px 0 rgba(0,0,0,${0.55 + i * 0.02})`);
  layers.push("22px 30px 28px rgba(0,0,0,0.45)");
  return `${layers.join(", ")}, 0 0 1px ${color}`;
}

const TextView: React.FC<{ text: TextOverlay; durationInFrames: number; timeline: Timeline; from: number }> = ({ text, durationInFrames, timeline, from }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const css = textTreatmentCss(text);
  // A pinned path runs on its clip's source time (ADR 0039); a drift runs over the text's own life.
  const position = textPositionAt(text, text.pin ? pinnedProgress(timeline, text, ((from + frame) * 1000) / fps) : durationInFrames > 1 ? frame / (durationInFrames - 1) : 0);
  useFontsFor(text.text, Number(css.fontWeight ?? 600));
  const { scale, opacity, rise, chars } = textMotion(text, frame, fps, durationInFrames);
  // The typewriter keeps the full text in place, invisible, so the box never changes size while it writes.
  const written = chars === null ? text.text : text.text.slice(0, chars);
  const cursor = chars !== null && chars < text.text.length && Math.floor(frame / (fps / 4)) % 2 === 0;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: position.x * width,
          top: position.y * height,
          width: width * 0.86,
          display: "flex",
          justifyContent: "center",
          transform: `translate(-50%, calc(-50% + ${rise * 40}px)) scale(${scale * position.scale}) rotate(${position.rotation}deg)`,
          opacity,
        }}
      >
        {chars === null ? (
          <span style={{ ...css, ...(text.depth === "extruded" ? { textShadow: extrudedShadow(text.color), WebkitTextStroke: "0.5px rgba(0,0,0,0.25)" } : {}) }}>{text.text}</span>
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
        return <Sequence key={`matte-${clip.id}`} from={from} durationInFrames={durationInFrames} name={`matte ${clip.id}`}><PersonMatteView clip={clip} asset={asset} /></Sequence>;
      })}
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

