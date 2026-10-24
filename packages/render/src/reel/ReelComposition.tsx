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
import { behindInPlane, calloutGeometry, calloutSvg, cameraAt, colorMatchFilterId, colorMatrixValues, countUpText, duckGain, evaluateTitle, flareCss, framePlan, hasSpeedRamps, hasSpeech, mediaWindow, glintLetter, glintSvg, INSTAGRAM, isInstagramMusic, kineticProgress, matrix3d, particleField, particleSvg, personLayerOpacity, REEL_FORMAT, sceneLayers, SFX_DUCK, SFX_SOUNDS, sfxAssetKey, sfxEndMs, sfxGainAt, shineAt, shineBandCss, shineSpec, slideFromBehind, planSpeedRamps, speechWindows, speedPlanOf, speedRampMediaWindow, TITLE_LEADING, timelineDurationMs, walkInto, withSpeedPlans, wordReveal, type Clip, type Logo, type ParticleField, type PersonPass, type Plan, type SfxClip, type ShineFlare, type ShineGlint, type TextOverlay, type Timeline } from "@reelwalk/core";
import { domMeasure } from "./measure";
import { textExit, titleFont } from "./title-motion";
import { whipGeometry } from "./whip";
import { zoomFilterSpec, zoomStageId } from "./zoom-blur";
import { clipPresentation } from "./presentation";
import { useFontsFor } from "./fonts";
import { clipFilterCss, ELEGANT_FADE_S, textTreatmentCss } from "./look";
import { DetailsCardView } from "./DetailsCardView";
import { EndCardView } from "./EndCardView";
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

/**
 * The speed-ramp transition's blur: a directional Gaussian (ADR 0073), σ along x and y in px, edges duplicated so the
 * frame's border does not go clear; or a zoom blur (ADR 0074), a stack of copies scaled about the focus (zoom-blur.ts).
 */
const SpeedBlur: React.FC<{ id: string; x: number; y: number; zoom: number; fx: number; fy: number }> = ({ id, x, y, zoom, fx, fy }) => {
  if (zoom > 0) return <ZoomBlur id={id} spread={zoom} fx={fx} fy={fy} />;
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation={`${x.toFixed(2)} ${y.toFixed(2)}`} edgeMode="duplicate" />
      </filter>
    </svg>
  );
};

/**
 * Zoom blur (ADR 0074) as one SVG filter per stage (zoom-blur.ts): the `feImage` ramp is the displacement map, the stage
 * displaces its input (the layer so far) and averages it with the original. The CSS `filter` chains the stages. sRGB so
 * the map is read as written, not as linear light.
 */
const ZoomBlur: React.FC<{ id: string; spread: number; fx: number; fy: number }> = ({ id, spread, fx, fy }) => {
  const spec = zoomFilterSpec(spread, fx, fy);
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      {spec.stages.map((stage, s) => (
        <filter key={s} id={zoomStageId(id, s)} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feImage href={spec.map} x="0" y="0" width={spec.width} height={spec.height} preserveAspectRatio="none" result="zmap" />
          <feDisplacementMap in="SourceGraphic" in2="zmap" scale={stage.scale.toFixed(2)} xChannelSelector="R" yChannelSelector="G" result="zc" />
          <feComposite in="SourceGraphic" in2="zc" operator="arithmetic" k1="0" k2={stage.keep.toFixed(4)} k3={stage.add.toFixed(4)} k4="0" />
        </filter>
      ))}
    </svg>
  );
};

/**
 * The clip's colour match (ADR 0070) as an SVG filter the CSS `filter: url(#…)`
 * on its media refers to. sRGB interpolation: the matrix was fitted to sRGB
 * statistics, and the SVG default (linearRGB) would apply it to linear light.
 */
const ColorMatchFilter: React.FC<{ clip: Clip }> = ({ clip }) => {
  if (!clip.colorMatch) return null;
  return <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
    <filter id={colorMatchFilterId(clip.id)} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values={colorMatrixValues(clip.colorMatch)} />
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
  /** The clip's sequence length: the media window is derived from it (frames.ts), so every frame of the sequence has a picture. */
  durationInFrames: number;
}> = ({ clip, asset, fit, muted, transform, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { isRendering } = useRemotionEnvironment();
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: fit,
    transform,
    filter: clipFilterCss(clip),
  };
  if (asset.kind === "IMAGE") return <Img src={resolveSrc(asset.src)} style={style} />;
  // Frame-exact cuts (ADR 0067): the window covers the whole sequence, never one frame short of the cut; a ramp
  // moves the rate per frame and fades the clip's own sound where the picture runs far from its mean speed.
  // A clip on a speed-ramp cut (ADR 0073) plays along its plan, which the composition attached; every other clip as before.
  const speedPlan = speedPlanOf(clip);
  const window = speedPlan ? speedRampMediaWindow(clip, speedPlan, frame, fps) : mediaWindow(clip, frame, durationInFrames, fps);
  const timing = {
    src: resolveSrc(asset.src),
    trimBefore: window.trimBefore,
    trimAfter: window.trimAfter,
    playbackRate: window.playbackRate,
    volume: muted ? 0 : clip.volume * window.gain,
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
  /** The reel's opening shot: an eased camera move starts already in progress (ADR 0067). */
  opening?: boolean;
}> = ({ clip, asset, durationInFrames, fadeOut, whipOut = null, previous, plan, opening = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!asset) {
    // The source was deleted. Show a neutral frame instead of failing the whole render.
    return <AbsoluteFill style={{ backgroundColor: "#262320" }} />;
  }

  // Clamped: a clip is mounted a second early (premount) with negative frames.
  const progress = durationInFrames > 1 ? Math.min(1, Math.max(0, frame / (durationInFrames - 1))) : 0;
  const { transform, opacity: shown, whip, whipAmount, whipId, whipDirection, speedBlur } = clipPresentation(clip, frame, fps, durationInFrames, fadeOut, whipOut, opening);

  if (clip.pano && asset.kind === "IMAGE") {
    const clipMs = (durationInFrames * 1000) / fps;
    // A walk needs the photo the camera is leaving; without it the clip simply cuts in.
    const from = previous?.asset?.kind === "IMAGE" && walkInto(plan, previous.clip, clip, clipMs) ? previous : undefined;
    const camera = from
      ? cameraAt(plan, from.clip, clip, (Math.max(0, frame) * 1000) / fps, clipMs)
      : cameraAt(plan, undefined, clip, progress, 1);
    return (
      <AbsoluteFill style={{ opacity: shown, backgroundColor: "#000", ...whip }}>
        {whipAmount !== 0 ? <WhipBlur id={whipId} amount={whipAmount} direction={whipDirection} /> : null}
        {speedBlur ? <SpeedBlur {...speedBlur} /> : null}
        <ColorMatchFilter clip={clip} />
        <PanoView
          src={resolveSrc(asset.src)}
          spot={clip.spot}
          from={from?.clip.spot && from.asset ? { src: resolveSrc(from.asset.src), spot: from.clip.spot } : null}
          camera={camera}
          planAspect={plan?.aspect ?? 1}
          style={{ filter: clipFilterCss(clip) }}
        />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ opacity: shown, overflow: "hidden" }}>
      {whipAmount !== 0 ? <WhipBlur id={whipId} amount={whipAmount} direction={whipDirection} /> : null}
      {speedBlur ? <SpeedBlur {...speedBlur} /> : null}
      <ColorMatchFilter clip={clip} />
      <AbsoluteFill style={whip}>
      {clip.fit === "contain" ? (
        // Letterboxed: the same picture, blurred and enlarged, fills the 9:16 frame behind it.
        <AbsoluteFill style={{ filter: "blur(48px) brightness(0.7)", transform: "scale(1.25)" }}>
          <Media clip={clip} asset={asset} fit="cover" muted durationInFrames={durationInFrames} />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill>
        <Media clip={clip} asset={asset} fit={clip.fit} transform={transform} durationInFrames={durationInFrames} muted={Boolean(clip.audio)} />
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
/**
 * Posts and cut-outs as a luminance mask (white plane, black polygons), polygons in plane px moved by (dx, dy) into
 * a box of width × height. A mask subtracts their union: an even-odd path put two overlapping posts back to visible
 * where they crossed, and two identical posts cancelled each other.
 */
function postsMask(shapes: number[][], width: number, height: number, dx = 0, dy = 0): React.CSSProperties {
  const posts = shapes.map((shape) => `<polygon points="${Array.from({ length: shape.length / 2 }, (_, i) => `${(shape[i * 2] + dx).toFixed(1)},${(shape[i * 2 + 1] + dy).toFixed(1)}`).join(" ")}" fill="black"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="white"/>${posts}</svg>`;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  // Luminance, not the default alpha: an image mask reads alpha unless told otherwise, and a black
  // polygon is as opaque as the white plane, so nothing would be cut (found on the phone, 2026-10-20).
  return { maskImage: url, WebkitMaskImage: url, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskMode: "luminance" };
}

const ParticleLayer: React.FC<{
  text: TextOverlay; layer: "front" | "back"; reelMs: number; box: { width: number; height: number }; style: React.CSSProperties;
  transform: (margin: { x: number; y: number }) => string;
  /** The title's posts, as a mask over the whole field. */
  mask?: (field: ParticleField) => React.CSSProperties;
}> = ({ text, layer, reelMs, box, style, transform, mask }) => {
  const particles = text.particles!;
  const field = particleField({ kind: particles.kind, density: particles.density, seed: particles.seed, timeMs: reelMs, box, burstMs: particles.burstMs });
  const common: React.CSSProperties = { position: "absolute", width: field.width, height: field.height, transformOrigin: "0 0", ...style, transform: transform({ x: field.marginX, y: field.marginY }), pointerEvents: "none", ...(mask ? mask(field) : {}) };
  // Two passes: flakes, dust, shadows and ember halos blend normally (so they show on a bright sky); ember sparks screen.
  return (
    <>
      <div aria-hidden="true" data-particles={`${particles.kind}-${layer}`} style={common}
        dangerouslySetInnerHTML={{ __html: particleSvg(field, layer, `particles-${text.id}-${layer}`, "normal") }} />
      {particles.kind === "embers" ? (
        <div aria-hidden="true" data-particles={`${particles.kind}-${layer}-screen`} style={{ ...common, mixBlendMode: "screen" }}
          dangerouslySetInnerHTML={{ __html: particleSvg(field, layer, `particles-${text.id}-${layer}-s`, "screen") }} />
      ) : null}
    </>
  );
};

/** "Apx Bpx" (or "Apx") padding as px. */
function paddingPx(padding: React.CSSProperties["padding"]): { x: number; y: number } {
  const parts = String(padding ?? "0").split(/\s+/).map((v) => parseFloat(v) || 0);
  return { y: parts[0] ?? 0, x: parts[1] ?? parts[0] ?? 0 };
}

/** The visible characters of `str` from `offset` on, with a glint (ADR 0061) on each that has one: a star on the letter's upper edge. */
function glinted(str: string, offset: number, glints: Map<number, ShineGlint>, colour: string): React.ReactNode {
  if (!glints.size) return str;
  const out: React.ReactNode[] = [];
  let run = "";
  [...str].forEach((ch, i) => {
    const glint = glints.get(offset + i);
    if (!glint) { run += ch; return; }
    if (run) { out.push(run); run = ""; }
    out.push(
      <span key={i} style={{ position: "relative" }}>{ch}<span aria-hidden="true" data-glint={glint.slot} style={{ position: "absolute", left: `${(glint.fx * 100).toFixed(2)}%`, top: `${(glint.fy * 100).toFixed(2)}%`, width: `${glint.size.toFixed(3)}em`, height: `${glint.size.toFixed(3)}em`, transform: "translate(-50%, -50%)", pointerEvents: "none", lineHeight: 0 }}
        dangerouslySetInnerHTML={{ __html: glintSvg(glint, colour) }} /></span>,
    );
  });
  if (run) out.push(run);
  return out;
}

/**
 * The letters of a title with shine or kinetic type (ADR 0061), inside its face span, in that span's own box: a
 * surface title's span is in plane px under the plane's warp, so everything here is carried by the tracked plane.
 *   - words: each word fades up and unblurs, staggered; count: the numbers count up over a hidden copy that holds the
 *     size (as the typewriter does, which this also draws when the title types);
 *   - shine: glints on chosen letters; the band is two copies of the letters (a shade-light-shade fill clipped to the
 *     glyphs, and a glow masked to the band's core). The flare is not drawn here but in FlareLayer, a sibling that
 *     screen-blends against the footage (inside the title's box it would only blend with the letters).
 * Everything is read from `titleMs` (the frame), so preview, stills and export agree.
 */
const MotionLetters: React.FC<{ text: TextOverlay; titleMs: number; face: React.CSSProperties; written: string | null; aspect: number }> = ({ text, titleMs, face, written, aspect }) => {
  const kinetic = text.kinetic;
  const progress = kinetic ? kineticProgress(kinetic, titleMs) : 1;
  // A string drawn over a hidden copy of the whole text: the count, or the typewriter's written part.
  const replaced = kinetic?.preset === "count" ? countUpText(text.text, progress) : kinetic?.preset === "words" ? null : written;
  const shine = text.shine ? shineAt(text.shine, titleMs, aspect) : null;
  const glintColour = text.shine ? shineSpec(text.shine).glintColor : "#ffffff";
  const glintsFor = (str: string) => new Map((shine?.glints ?? []).map((g) => [glintLetter(str, g), g] as const).filter(([i]) => i >= 0));
  const body = (str: string, withGlints: boolean): React.ReactNode => {
    const glints = withGlints ? glintsFor(str) : new Map<number, ShineGlint>();
    if (kinetic?.preset !== "words") return glinted(str, 0, glints, glintColour);
    let offset = 0;
    return wordReveal(str, kinetic, titleMs).map((part, i) => {
      const at = offset;
      offset += [...part.text].length;
      if (part.space) return part.text;
      return (
        <span key={i} style={{ display: "inline-block", whiteSpace: "pre", opacity: part.opacity, transform: part.rise ? `translateY(${part.rise}em)` : undefined, filter: part.blur > 0.01 ? `blur(${part.blur}px)` : undefined }}>
          {glinted(part.text, at, glints, glintColour)}
        </span>
      );
    });
  };
  const layer = (withGlints: boolean): React.ReactNode => replaced === null ? body(text.text, withGlints) : (<>
    <span style={{ visibility: "hidden" }}>{text.text}</span>
    <span style={{ position: "absolute", inset: face.padding ?? 0, textAlign: "inherit" }}>{body(replaced, withGlints)}</span>
  </>);
  const band = shine?.band && shine.band.opacity > 0.001 ? shineBandCss(shine.band) : null;
  return (
    <>
      {layer(true)}
      {band ? (<>
        {/* Shade, light, shade across the band, clipped to the letters: reads on white letters as well as coloured ones. */}
        <span aria-hidden="true" data-shine="tone" style={{ position: "absolute", inset: 0, padding: face.padding, color: "transparent", textShadow: "none", WebkitTextStroke: "0", backgroundColor: "transparent", boxShadow: "none",
          backgroundImage: band.tone.backgroundImage, backgroundClip: "text", WebkitBackgroundClip: "text", backgroundSize: "100% 100%", opacity: band.tone.opacity, pointerEvents: "none" }}>
          {layer(false)}
        </span>
        <span aria-hidden="true" data-shine="bloom" style={{ position: "absolute", inset: 0, padding: face.padding, color: band.bloom.color, textShadow: band.bloom.textShadow, WebkitTextStroke: "0", backgroundColor: "transparent", boxShadow: "none",
          maskImage: band.bloom.maskImage, WebkitMaskImage: band.bloom.maskImage, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", opacity: band.bloom.opacity, pointerEvents: "none" }}>
          {layer(false)}
        </span>
      </>) : null}
    </>
  );
};

/**
 * The golden-hour streak (ADR 0061): a layer of its own beside the title, positioned and warped exactly as the words'
 * box (`box`: left, top, width, height in the parent's px; `fontSize` the words' px, for its em height), and
 * screen-blended, like the ember sparks, so it lightens the footage under it rather than painting over it.
 */
const FlareLayer: React.FC<{ flare: ShineFlare; frame: React.CSSProperties; box: { left: number; top: number; width: number; height: number }; fontSize: number }> = ({ flare, frame, box, fontSize }) => (
  <div aria-hidden="true" data-shine="flare" style={{ position: "absolute", pointerEvents: "none", mixBlendMode: "screen", ...frame }}>
    <span style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, fontSize }}>
      <span style={{ position: "absolute", ...flareCss(flare), borderRadius: "50%" }} />
    </span>
  </div>
);

/** A callout's dot and leader line (ADR 0061), over the whole composition, under its label. */
const CalloutLine: React.FC<{ svg: string; opacity: number }> = ({ svg, opacity }) => (
  <div aria-hidden="true" data-callout="line" style={{ position: "absolute", inset: 0, opacity, pointerEvents: "none" }} dangerouslySetInnerHTML={{ __html: svg }} />
);

/**
 * The presenter matte of a group of passing titles (ADR 0055): drawn at personLayerOpacity, 0 until she walks
 * through the words. While it is 0 the matte is idle (no decode, no segmentation).
 */
const PassFade: React.FC<{ pass: PersonPass; from: number; children: (active: boolean) => React.ReactNode }> = ({ pass, from, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = personLayerOpacity({ pass }, from + frame, fps);
  return <AbsoluteFill style={{ pointerEvents: "none", opacity }}>{children(opacity > 0)}</AbsoluteFill>;
};

const TextView: React.FC<{ text: TextOverlay; durationInFrames: number; timeline: Timeline; from: number }> = ({ text, durationInFrames, timeline, from }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const css = textTreatmentCss(text);
  // A count-up draws tabular figures (ADR 0061): measured the same way, so its fit leaves room for the widest number.
  const font = titleFont(text, css);
  // Hooks first: a pinned title on another clip returns nothing, but only after every hook has run (React 300 otherwise).
  useFontsFor(text.text, Number(css.fontWeight ?? 600));
  // Word-by-word and from-behind type bring the words in themselves but keep the way out (an elegant fade) (ADR 0061);
  // a callout has its own reveal and exit; a count replaces the typewriter.
  const arrives = text.callout || (text.kinetic?.preset === "count" && text.animation === "type") ? { ...text, animation: "none" as const } : text;
  const { scale, opacity, rise, chars } = text.kinetic && text.kinetic.preset !== "count" && !text.callout ? textExit(text, frame, fps, durationInFrames) : textMotion(arrives, frame, fps, durationInFrames);
  /** The golden-hour streak on this frame; `aspect` is the words' box height / width, for where the tilted band crosses its middle. */
  const flareAt = (aspect: number) => (text.shine ? shineAt(text.shine, (frame * 1000) / fps, aspect).flare : null);
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
  // Shine and kinetic type (ADR 0061): drawn inside the face span, so in the plane for a surface title.
  const titleMs = (frame * 1000) / fps;
  const moving = Boolean(text.shine || text.kinetic);
  const motionFace: React.CSSProperties = { ...face, position: "relative", ...(text.kinetic?.preset === "count" ? { fontVariantNumeric: "tabular-nums" } : {}) };
  const letters = (aspect: number) => <MotionLetters text={text} titleMs={titleMs} face={face} written={chars === null ? null : `${written}${cursor ? "|" : ""}`} aspect={aspect} />;
  /** "From behind": the slide (px, in the box the edges are given in) and the polygon that clips the side the words come from. */
  const behind = (textLeft: number, textRight: number, edge: number) => {
    const slide = slideFromBehind({ spec: text.kinetic!, titleMs, textLeft, textRight, edge });
    const far = 100000;
    const clip = slide.clipLeft !== undefined
      ? `polygon(${slide.clipLeft.toFixed(2)}px ${-far}px, ${far}px ${-far}px, ${far}px ${far}px, ${slide.clipLeft.toFixed(2)}px ${far}px)`
      : `polygon(${-far}px ${-far}px, ${slide.clipRight!.toFixed(2)}px ${-far}px, ${slide.clipRight!.toFixed(2)}px ${far}px, ${-far}px ${far}px)`;
    return { dx: slide.dx, clipPath: clip };
  };
  if (placement.kind === "surface") {
    const { rect, placed, fitScale, maskShapes, clipToPlane } = placement;
    const w = rect.width, h = rect.height;
    const mask: React.CSSProperties = maskShapes ? postsMask(maskShapes, w, h) : {};
    // From behind a post, a cut-out or a tapped object (ADR 0061): its edge in plane px, the words' box in plane px.
    let slide: { dx: number; clipPath: string } | null = null;
    if (text.kinetic?.preset === "behind") {
      // Posts and cut-outs (plane px) and tapped objects (carried back into the plane) level with the words.
      const box = behindInPlane(placement, { width, height });
      slide = behind(box.textLeft, box.textRight, box.edge);
    }
    // Particles live in the plane: the same warp as the words, from a box the margin larger on every side. The
    // posts hide them as they hide the letters (the mask moved by the margin); outside the surface's edge they still show.
    const planeParticles = (layer: "front" | "back") => text.particles && placed ? (
      <ParticleLayer text={text} layer={layer} reelMs={reelMs} box={{ width: w, height: h }} style={{ left: rect.left, top: rect.top, opacity: visible }} transform={(m) => `${matrix3d(placed)} translate(${-m.x}px, ${-m.y}px)`}
        mask={maskShapes ? (field) => postsMask(maskShapes, field.width, field.height, field.marginX, field.marginY) : undefined} />
    ) : null;
    return (
      <AbsoluteFill style={{ pointerEvents: "none", perspective: "none" }}>
        {planeParticles("back")}
        {/* Painted on a chosen surface, the text exists only on that surface: anything in front of the surface's edge (a wall, a railing) hides it. */}
        <div style={{ position: "absolute", left: rect.left, top: rect.top, width: w, height: h, display: "flex", alignItems: "center", justifyContent: "center", transformOrigin: "0 0", transform: placed ? matrix3d(placed) : undefined, opacity: visible, whiteSpace: "nowrap", textAlign: "center", overflow: clipToPlane ? "hidden" : "visible", ...mask, ...meet, ...(slide ? { clipPath: slide.clipPath } : {}) }}>
          {/* The plane's box is only its frame: the words sit on one line (or the lines the author typed), scaled to fill or fit it, warped with it. */}
          <span style={{ ...(moving ? motionFace : face), position: "relative", whiteSpace: text.text.includes("\n") ? "pre" : "nowrap", overflowWrap: "normal", wordBreak: "keep-all", transform: `${slide ? `translateX(${slide.dx.toFixed(2)}px) ` : ""}scale(${scale * fitScale})` }}>
            {moving ? letters(h / Math.max(1, w)) : chars === null ? text.text : (<>
              {/* The typewriter on a plane: the full text holds the size, the written part sits over it. */}
              <span style={{ visibility: "hidden" }}>{text.text}</span>
              <span style={{ position: "absolute", inset: 0, textAlign: "inherit" }}>{written}{cursor ? "|" : ""}</span>
            </>)}
          </span>
        </div>
        {text.shine ? (() => {
          const lineW = placement.lineBox.width * fitScale * scale, lineH = placement.lineBox.height * fitScale * scale;
          const flare = flareAt(lineH / Math.max(1, lineW));
          if (!flare || flare.opacity <= 0.001) return null;
          return <FlareLayer flare={flare} fontSize={font.fontSize * fitScale * scale}
            frame={{ left: rect.left, top: rect.top, width: w, height: h, transformOrigin: "0 0", transform: placed ? matrix3d(placed) : undefined, opacity: visible, overflow: clipToPlane ? "hidden" : "visible", ...mask }}
            box={{ left: (w - lineW) / 2 + (slide?.dx ?? 0), top: (h - lineH) / 2, width: lineW, height: lineH }} />;
        })() : null}
        {planeParticles("front")}
      </AbsoluteFill>
    );
  }

  const { center, wrap } = placement;
  // A callout (ADR 0061): the dot and the line under the label, and the label settling out along the line.
  let callout: { svg: string; opacity: number; label: number; shift: { x: number; y: number } } | null = null;
  if (placement.callout) {
    const pad = paddingPx(css.padding);
    const lineW = Math.max(...text.text.split("\n").map((part) => domMeasure(part || " ", font).width));
    const g = calloutGeometry({
      anchor: placement.callout.anchor, titleMs, lifeMs: (durationInFrames * 1000) / fps, width,
      label: { x: center.x, y: center.y, halfWidth: lineW / 2 + pad.x, halfHeight: (font.fontSize * (Number(css.lineHeight) || TITLE_LEADING)) / 2 + pad.y },
    });
    callout = { svg: calloutSvg(g, { width, height }, text.color), opacity: visible * g.opacity, label: g.label.opacity * g.opacity, shift: g.label.shift };
  }
  const labelShift = callout ? `translate(${callout.shift.x.toFixed(2)}px, ${callout.shift.y.toFixed(2)}px) ` : "";
  const motion = `${labelShift}translate(-50%, calc(-50% + ${rise * 40}px)) scale(${scale * placement.scale}) rotate(${placement.rotation}deg)`;
  // From behind, on the screen (ADR 0061): out from behind the words' own left edge, in the box's own px.
  let slide: { dx: number; clipPath: string } | null = null;
  if (text.kinetic?.preset === "behind") {
    const pad = paddingPx(css.padding);
    const widest = Math.max(...text.text.split("\n").map((part) => domMeasure(part || " ", font).width));
    const textW = wrap.mode === "wrap" ? Math.min(wrap.width, widest) : Math.min(wrap.maxWidth, widest + 2 * pad.x);
    const boxW = wrap.mode === "wrap" ? wrap.width : textW;
    const textLeft = (boxW - textW) / 2;
    slide = behind(textLeft, textLeft + textW, textLeft);
  }
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
      {callout ? <CalloutLine svg={callout.svg} opacity={callout.opacity} /> : null}
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
          ...meet,
          // After the surface blend, whose own 0.92 is kept: the callout's reveal multiplies it rather than being overwritten.
          opacity: visible * (text.blend === "surface" ? 0.92 : 1) * (callout ? callout.label : 1),
          ...(slide ? { clipPath: slide.clipPath } : {}),
        }}
      >
        {moving ? (
          <span style={{ ...motionFace, ...(slide ? { transform: `translateX(${slide.dx.toFixed(2)}px)` } : {}) }}>{letters(0.25)}</span>
        ) : chars === null ? (
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
      {text.shine ? (() => {
        const widest = Math.max(...text.text.split("\n").map((part) => domMeasure(part || " ", font).width));
        const lineW = wrap.mode === "wrap" ? Math.min(wrap.width, widest) : Math.min(wrap.maxWidth, widest);
        const lineH = font.fontSize * TITLE_LEADING * text.text.split("\n").length;
        const flare = flareAt(lineH / Math.max(1, lineW));
        if (!flare || flare.opacity <= 0.001) return null;
        return <FlareLayer flare={flare} fontSize={font.fontSize} frame={{ left: center.x, top: center.y, width: lineW, height: lineH, transform: motion, opacity: visible }} box={{ left: slide?.dx ?? 0, top: 0, width: lineW, height: lineH }} />;
      })() : null}
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
 * Sound design (ADR 0066): each placed sound in its own sequence, at its
 * gain through its fades, ducked under speech more deeply than the music.
 * An ambience loops to fill its window; the rest play once from `offsetMs`.
 * The sound files come through `assets` under `sfx:<sound>`, so the preview
 * and the worker play the same bytes from their own URLs.
 */
const SfxTrack: React.FC<{ timeline: Timeline; assets: Record<string, ReelAsset>; speech: ReturnType<typeof speechWindows> }> = ({ timeline, assets, speech }) => {
  const { fps } = useVideoConfig();
  const toFrame = (ms: number) => Math.round((ms * fps) / 1000);
  return (
    <>
      {(timeline.sfx ?? []).map((clip: SfxClip) => {
        const asset = assets[sfxAssetKey(clip.sound)];
        if (!asset) return null;
        const from = toFrame(clip.atMs);
        const durationInFrames = Math.max(1, toFrame(sfxEndMs(clip)) - from);
        const spec = SFX_SOUNDS[clip.sound];
        return (
          <Sequence key={clip.id} from={from} durationInFrames={durationInFrames} name={`sfx ${clip.sound}`}>
            <Audio
              src={resolveSrc(asset.src)}
              trimBefore={toFrame(clip.offsetMs ?? 0)}
              loop={spec.loop}
              volume={(frame) => {
                const atMs = clip.atMs + (frame * 1000) / fps;
                return sfxGainAt(clip, atMs) * duckGain(speech, atMs, SFX_DUCK);
              }}
            />
          </Sequence>
        );
      })}
    </>
  );
};

/**
 * The whole reel. Used by the Player in the editor and by the worker for the
 * final MP4, so the export always matches the preview.
 */
export const ReelComposition: React.FC<ReelProps> = ({ timeline: saved, assets, watermark = false }) => {
  const { fps } = useVideoConfig();
  // Speed-ramp cuts (ADR 0073) are planned here, once, from the frame plan and the assets' lengths, and each clip they
  // touch carries its plan: the media, the mattes and the blur all read the same frames, in the preview and the export.
  const timeline = React.useMemo(() => {
    if (!hasSpeedRamps(saved)) return saved;
    const frames = framePlan(saved, fps).clips;
    return withSpeedPlans(saved, planSpeedRamps(frames.map(({ clip, durationInFrames }) => ({ clip, durationInFrames, sourceDurationMs: assets[clip.assetId]?.durationMs ?? null, speech: hasSpeech(assets[clip.assetId]?.transcript) })), fps));
  }, [saved, assets, fps]);
  const plan = framePlan(timeline, fps);
  const musicAsset = timeline.music ? assets[timeline.music.assetId] : undefined;
  // Speech in reel time, for ducking the sound design (the music track finds its own, ADR 0035).
  const sfxSpeech = React.useMemo(
    () => (timeline.sfx?.length ? speechWindows(timeline, Object.fromEntries(Object.entries(assets).map(([id, entry]) => [id, entry.transcript]))) : []),
    [timeline, assets],
  );

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
            opening={index === 0}
          />
          {/* A J-cut (ADR 0069): the sound under a cutaway is the presenter take it covers, from the same source time. */}
          {clip.audio && assets[clip.audio.assetId]?.kind === "VIDEO" ? (
            <Audio src={resolveSrc(assets[clip.audio.assetId].src)} trimBefore={Math.round((clip.audio.sourceStartMs * fps) / 1000)} volume={clip.audio.volume} />
          ) : null}
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
          // A group of passing titles' presenter (ADR 0055): above those titles only, faded in as she walks through the words.
          if (layer.pass) {
            const pass = layer.pass;
            return (
              <Sequence key={`matte-${clip.id}-pass-${pass.passMs}-${pass.passFadeMs}`} from={from} durationInFrames={durationInFrames} name={`passes ${clip.id}`}>
                <PassFade pass={pass} from={from}>{(active) => <PersonMatteView clip={clip} asset={asset} durationInFrames={durationInFrames} fadeOut={fadeOut} whipOut={whipOut} active={active} opening={layer.clipIndex === 0} />}</PassFade>
              </Sequence>
            );
          }
          return (
            <Sequence key={`matte-${clip.id}`} from={from} durationInFrames={durationInFrames} name={`matte ${clip.id}`}>
              <PersonMatteView clip={clip} asset={asset} durationInFrames={durationInFrames} fadeOut={fadeOut} whipOut={whipOut} opening={layer.clipIndex === 0} />
            </Sequence>
          );
        }
        // Things tapped as being in front of this title (ADR 0044): the object under the tap.
        return (
          <Sequence key={`object-${clip.id}-${layer.text.id}`} from={from} durationInFrames={durationInFrames} name={`in front of ${layer.text.text.slice(0, 12)}`}>
            <ObjectMatteView clip={clip} asset={asset} text={layer.text} timeline={timeline} from={from} durationInFrames={durationInFrames} fadeOut={fadeOut} whipOut={whipOut} opening={layer.clipIndex === 0} />
          </Sequence>
        );
      })}
      {timeline.hook && plan.clips[0] ? <HookView timeline={timeline} hook={timeline.hook} firstClip={plan.clips[0].clip} asset={assets[plan.clips[0].clip.assetId]} /> : null}
      <DetailsCardView timeline={timeline} />
      <EndCardView timeline={timeline} />
      {timeline.logo ? <LogoView logo={timeline.logo} asset={assets[timeline.logo.assetId]} /> : null}
      {watermark ? <Watermark /> : null}
      {musicAsset ? <MusicTrack timeline={timeline} asset={musicAsset} assets={assets} /> : null}
      {timeline.sfx?.length ? <SfxTrack timeline={timeline} assets={assets} speech={sfxSpeech} /> : null}
    </AbsoluteFill>
  );
};

export function reelDurationInFrames(timeline: Timeline, fps: number = REEL_FORMAT.fps): number {
  return Math.max(1, Math.round((timelineDurationMs(timeline) * fps) / 1000));
}

