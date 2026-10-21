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
import { cameraAt, duckGain, evaluateTitle, framePlan, INSTAGRAM, isInstagramMusic, matrix3d, particleField, particleSvg, personLayerOpacity, REEL_FORMAT, sceneLayers, speechWindows, TITLE_LEADING, timelineDurationMs, walkInto, type Clip, type Logo, type PersonPass, type Plan, type TextOverlay, type Timeline } from "@reelwalk/core";
import { domMeasure } from "./measure";
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

/**
 * A title's particles (ADR 0055): one layer (in front of or behind the letters) of a field that is a pure
 * function of the reel time and the seed, so preview and export draw the same flakes. The box is the
 * title's plane (or its screen box) plus a margin; `transform` is the title's own, so the field moves with it.
 */
const ParticleLayer: React.FC<{ text: TextOverlay; layer: "front" | "back"; reelMs: number; box: { width: number; height: number }; style: React.CSSProperties; transform: (margin: number) => string }> = ({ text, layer, reelMs, box, style, transform }) => {
  const particles = text.particles!;
  const field = particleField({ kind: particles.kind, density: particles.density, seed: particles.seed, timeMs: reelMs, box });
  return (
    <div
      aria-hidden="true"
      data-particles={`${particles.kind}-${layer}`}
      style={{ position: "absolute", width: field.width, height: field.height, transformOrigin: "0 0", ...style, transform: transform(field.margin), mixBlendMode: "screen", pointerEvents: "none" }}
      dangerouslySetInnerHTML={{ __html: particleSvg(field, layer, `particles-${text.id}-${layer}`) }}
    />
  );
};

/** The presenter matte of a passing title (ADR 0055): drawn at personLayerOpacity, 0 until she walks through the words. */
const PassFade: React.FC<{ pass: PersonPass; from: number; children: React.ReactNode }> = ({ pass, from, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <AbsoluteFill style={{ pointerEvents: "none", opacity: personLayerOpacity({ pass }, from + frame, fps) }}>{children}</AbsoluteFill>;
};

const TextView: React.FC<{ text: TextOverlay; durationInFrames: number; timeline: Timeline; from: number }> = ({ text, durationInFrames, timeline, from }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const css = textTreatmentCss(text);
  const font = { fontFamily: String(css.fontFamily ?? ""), fontWeight: css.fontWeight, fontSize: Number(css.fontSize) || 64, letterSpacing: text.tracking, fontStretch: css.fontStretch ? String(css.fontStretch) : undefined };
  // Hooks first: a pinned title on another clip returns nothing, but only after every hook has run (React 300 otherwise).
  useFontsFor(text.text, Number(css.fontWeight ?? 600));
  const { scale, opacity, rise, chars } = textMotion(text, frame, fps, durationInFrames);
  // Where the title is on this frame comes from one place (ADR 0046): the scene evaluator in core.
  const placement = evaluateTitle({ text, timeline, frame, from, durationInFrames, fps, width, height, font, measure: domMeasure });
  if (placement.kind === "hidden") return null;
  const face = { ...css, ...(text.depth === "extruded" ? { textShadow: extrudedShadow(text.color, font.fontSize), WebkitTextStroke: `${Math.max(0.5, font.fontSize * 0.01)}px rgba(0,0,0,0.35)` } : {}) };
  const visible = opacity * placement.opacity;
  // The typewriter keeps the full text in place, invisible, so the box never changes size while it writes.
  const written = chars === null ? text.text : text.text.slice(0, chars);
  const cursor = chars !== null && chars < text.text.length && Math.floor(frame / (fps / 4)) % 2 === 0;
  // Paint on the surface: hard-light keeps the wall's own light and grain through the letters (white lightens, dark darkens), with the footage's softness.
  // The blend's own 0.92 multiplies the fade; spread after `opacity`, a flat 0.92 used to cancel it.
  const meet = text.blend === "surface" ? { mixBlendMode: "hard-light" as const, filter: "blur(0.6px)", opacity: visible * 0.92 } : {};
  const reelMs = ((from + frame) * 1000) / fps;
  if (placement.kind === "surface") {
    const { rect, placed, fitScale, maskShapes, clipToPlane } = placement;
    const w = rect.width, h = rect.height;
    let mask: React.CSSProperties = {};
    if (maskShapes) {
      // Posts are cut out of the plane in the plane's own coordinates, so they warp with it. A mask
      // (white plane, black posts) subtracts their union: an even-odd path put two overlapping posts
      // back to visible where they crossed, and two identical posts cancelled each other.
      const posts = maskShapes.map((shape) => `<polygon points="${Array.from({ length: shape.length / 2 }, (_, i) => `${shape[i * 2].toFixed(1)},${shape[i * 2 + 1].toFixed(1)}`).join(" ")}" fill="black"/>`).join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="white"/>${posts}</svg>`;
      const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
      // Luminance, not the default alpha: an image mask reads alpha unless told otherwise, and a black
      // polygon is as opaque as the white plane, so nothing would be cut (found on the phone, 2026-10-20).
      mask = { maskImage: url, WebkitMaskImage: url, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskMode: "luminance" };
    }
    // Particles live in the plane: the same warp as the words, from a box the margin larger on every side.
    const planeParticles = (layer: "front" | "back") => text.particles && placed ? (
      <ParticleLayer text={text} layer={layer} reelMs={reelMs} box={{ width: w, height: h }} style={{ left: rect.left, top: rect.top, opacity: visible }} transform={(m) => `${matrix3d(placed)} translate(${-m}px, ${-m}px)`} />
    ) : null;
    return (
      <AbsoluteFill style={{ pointerEvents: "none", perspective: "none" }}>
        {planeParticles("back")}
        {/* Painted on a chosen surface, the text exists only on that surface: anything in front of the surface's edge (a wall, a railing) hides it. */}
        <div style={{ position: "absolute", left: rect.left, top: rect.top, width: w, height: h, display: "flex", alignItems: "center", justifyContent: "center", transformOrigin: "0 0", transform: placed ? matrix3d(placed) : undefined, opacity: visible, whiteSpace: "nowrap", textAlign: "center", overflow: clipToPlane ? "hidden" : "visible", ...mask, ...meet }}>
          {/* The plane's box is only its frame: the words sit on one line (or the lines the author typed), scaled to fill or fit it, warped with it. */}
          <span style={{ ...face, position: "relative", whiteSpace: text.text.includes("\n") ? "pre" : "nowrap", overflowWrap: "normal", wordBreak: "keep-all", transform: `scale(${scale * fitScale})` }}>
            {chars === null ? text.text : (<>
              {/* The typewriter on a plane: the full text holds the size, the written part sits over it. */}
              <span style={{ visibility: "hidden" }}>{text.text}</span>
              <span style={{ position: "absolute", inset: 0, textAlign: "inherit" }}>{written}{cursor ? "|" : ""}</span>
            </>)}
          </span>
        </div>
        {planeParticles("front")}
      </AbsoluteFill>
    );
  }

  const { center, wrap } = placement;
  const motion = `translate(-50%, calc(-50% + ${rise * 40}px)) scale(${scale * placement.scale}) rotate(${placement.rotation}deg)`;
  // A screen title's particles fill its text box (the wrap width, or the measured line), centred where the words are.
  const screenParticles = (layer: "front" | "back") => {
    if (!text.particles) return null;
    const widest = Math.max(...text.text.split("\n").map((part) => domMeasure(part || " ", font).width));
    const lines = text.text.split("\n").length * (wrap.mode === "wrap" ? Math.max(1, Math.ceil(widest / wrap.width)) : 1);
    const box = { width: wrap.mode === "wrap" ? Math.min(wrap.width, widest) : Math.min(wrap.maxWidth, widest), height: font.fontSize * TITLE_LEADING * lines };
    return <ParticleLayer text={text} layer={layer} reelMs={reelMs} box={box} style={{ left: center.x, top: center.y, opacity: visible, transformOrigin: "50% 50%" }} transform={() => motion} />;
  };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {screenParticles("back")}
      <div
        style={{
          position: "absolute",
          left: center.x,
          top: center.y,
          // A single word never breaks mid-word (a tracked title is usually one word); sentences wrap inside the safe width.
          ...(wrap.mode === "wrap" ? { width: wrap.width } : { width: "max-content", maxWidth: wrap.maxWidth, whiteSpace: "nowrap" as const }),
          display: "flex",
          justifyContent: "center",
          transform: motion,
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
      {screenParticles("front")}
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
      {/* Titles and what stands in front of them, bottom to top (ADR 0046): each title's occluders draw above
          that title only; the presenter above the "behind" titles, a plain caption above every matte. */}
      {sceneLayers(timeline, fps, (clip) => assets[clip.assetId]?.kind === "VIDEO").map((layer) => {
        if (layer.kind === "title") {
          const { text, from, durationInFrames } = layer;
          return (
            <Sequence key={text.id} from={from} durationInFrames={durationInFrames} name={`text ${text.text.slice(0, 12)}`}>
              <TextView text={text} durationInFrames={durationInFrames} timeline={timeline} from={from} />
            </Sequence>
          );
        }
        const clip = timeline.clips[layer.clipIndex];
        const asset = assets[clip.assetId];
        const { from, durationInFrames } = layer;
        const next = timeline.clips[layer.clipIndex + 1];
        const fadeOut = next?.transitionIn === "fade";
        const whipOut = next?.transitionIn === "whip" ? next.whipDirection ?? "right" : null;
        if (layer.kind === "person") {
          // People in front of the type (ADR 0039): a person-only matte of the clip.
          const matte = <PersonMatteView clip={clip} asset={asset} durationInFrames={durationInFrames} fadeOut={fadeOut} whipOut={whipOut} />;
          // A passing title's own presenter (ADR 0055): above that title only, faded in as she walks through the words.
          if (layer.pass) {
            return (
              <Sequence key={`matte-${clip.id}-${layer.pass.textId}`} from={from} durationInFrames={durationInFrames} name={`passes ${clip.id}`}>
                <PassFade pass={layer.pass} from={from}>{matte}</PassFade>
              </Sequence>
            );
          }
          return (
            <Sequence key={`matte-${clip.id}`} from={from} durationInFrames={durationInFrames} name={`matte ${clip.id}`}>
              {matte}
            </Sequence>
          );
        }
        // Things tapped as being in front of this title (ADR 0044): the object under the tap.
        return (
          <Sequence key={`object-${clip.id}-${layer.text.id}`} from={from} durationInFrames={durationInFrames} name={`in front of ${layer.text.text.slice(0, 12)}`}>
            <ObjectMatteView clip={clip} asset={asset} text={layer.text} timeline={timeline} from={from} durationInFrames={durationInFrames} fadeOut={fadeOut} whipOut={whipOut} />
          </Sequence>
        );
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

