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
import { framePlan, REEL_FORMAT, timelineDurationMs, type Clip, type TextOverlay, type Timeline } from "@reelwalk/core";
import { useFontsFor } from "./fonts";
import { FILTER_CSS, textCss } from "./look";
import type { ReelAsset, ReelProps } from "./types";

/** Frames of the dip-to-black on each side of a "fade" transition. */
const FADE_FRAMES = 8;

function resolveSrc(src: string): string {
  return /^(https?:|blob:|data:)/.test(src) ? src : staticFile(src);
}

function motionTransform(motion: Clip["motion"], progress: number): string | undefined {
  switch (motion) {
    case "zoom-in":
      return `scale(${1 + 0.14 * progress})`;
    case "zoom-out":
      return `scale(${1.14 - 0.14 * progress})`;
    case "pan":
      return `scale(1.16) translateX(${interpolate(progress, [0, 1], [-5, 5])}%)`;
    default:
      return undefined;
  }
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

const ClipView: React.FC<{ clip: Clip; asset: ReelAsset | undefined; durationInFrames: number; fadeOut: boolean }> = ({
  clip,
  asset,
  durationInFrames,
  fadeOut,
}) => {
  const frame = useCurrentFrame();
  if (!asset) {
    // The source was deleted. Show a neutral frame instead of failing the whole render.
    return <AbsoluteFill style={{ backgroundColor: "#163a5c" }} />;
  }

  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;
  const transform = asset.kind === "IMAGE" ? motionTransform(clip.motion, progress) : undefined;
  const fadeIn = clip.transitionIn === "fade" ? interpolate(frame, [0, FADE_FRAMES], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const fadeOutValue = fadeOut
    ? interpolate(frame, [durationInFrames - FADE_FRAMES, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;

  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOutValue), overflow: "hidden" }}>
      {clip.fit === "contain" ? (
        // Letterboxed: the same picture, blurred and enlarged, fills the 9:16 frame behind it.
        <AbsoluteFill style={{ filter: "blur(48px) brightness(0.7)", transform: "scale(1.25)" }}>
          <Media clip={clip} asset={asset} fit="cover" muted />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill>
        <Media clip={clip} asset={asset} fit={clip.fit} transform={transform} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const TextView: React.FC<{ text: TextOverlay }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const css = textCss(text.style, text.color, text.size);
  useFontsFor(text.text, Number(css.fontWeight ?? 600));
  // A short pop on entry, the way Instagram animates text in.
  const pop = spring({ frame, fps, config: { damping: 14, stiffness: 180 }, durationInFrames: 10 });
  const scale = interpolate(pop, [0, 1], [0.86, 1]);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: text.x * width,
          top: text.y * height,
          width: width * 0.86,
          display: "flex",
          justifyContent: "center",
          transform: `translate(-50%, -50%) scale(${scale})`,
          opacity: interpolate(frame, [0, 3], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <span style={css}>{text.text}</span>
      </div>
    </AbsoluteFill>
  );
};

const MusicTrack: React.FC<{ timeline: Timeline; asset: ReelAsset }> = ({ timeline, asset }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const music = timeline.music!;
  const fadeFrames = Math.min(fps, Math.floor(durationInFrames / 3));
  return (
    <Audio
      src={resolveSrc(asset.src)}
      trimBefore={Math.round((music.sourceStartMs * fps) / 1000)}
      loop
      // Fade out over the last second so the reel does not end mid-note.
      volume={(frame) =>
        music.volume *
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
export const ReelComposition: React.FC<ReelProps> = ({ timeline, assets }) => {
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
          />
        </Sequence>
      ))}
      {plan.texts.map(({ text, from, durationInFrames }) => (
        <Sequence key={text.id} from={from} durationInFrames={durationInFrames} name={`text ${text.text.slice(0, 12)}`}>
          <TextView text={text} />
        </Sequence>
      ))}
      {musicAsset ? <MusicTrack timeline={timeline} asset={musicAsset} /> : null}
    </AbsoluteFill>
  );
};

export function reelDurationInFrames(timeline: Timeline, fps: number = REEL_FORMAT.fps): number {
  return Math.max(1, Math.round((timelineDurationMs(timeline) * fps) / 1000));
}

