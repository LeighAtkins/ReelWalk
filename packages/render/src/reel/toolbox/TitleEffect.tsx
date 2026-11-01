import React, { useId } from "react";
import { clipPathOf, seedOf, titleEffectFrame, wavePath, type EffectDecor, type PartState, type TitleEffect as Effect } from "./title-effects";

/**
 * Draws a title with one of the sixteen effects (ADR 0103) inside the title's own box: the letters (or words, or the
 * whole line) moved by titleEffectFrame, the decorations (dots, lines, rings, pixels, trails) in an SVG laid over the
 * same box, and the mosaic or LED treatments. `face` is the title's own style (font, colour, shadow), so a kit style or
 * the elegant serif keeps its look; `boxWidth` and `fontSize` are px, for the decorations.
 */
export const TitleEffect: React.FC<{
  effect: Effect;
  text: string;
  face: React.CSSProperties;
  color: string;
  fontSize: number;
  boxWidth: number;
  /** The text block's height in em (its wrapped lines times the leading). */
  heightEm?: number;
  titleMs: number;
  lifeMs: number;
}> = ({ effect, text, face, color, fontSize, boxWidth, heightEm, titleMs, lifeMs }) => {
  const filterId = `rw-mosaic-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const words = text.split(/\s+/).filter(Boolean);
  const f = titleEffectFrame(effect, { titleMs, lifeMs, chars: text.length, words: words.length, seed: seedOf(text), heightEm });
  const outer: React.CSSProperties = {
    position: "relative",
    display: "inline-block",
    opacity: f.opacity,
    transformOrigin: effect === "heavyLanding" ? "50% 100%" : "50% 50%",
    transform: `translate(${f.x}em, ${f.y}em) rotate(${f.rotate}deg) scale(${f.scale}) scale(${f.scaleX}, ${f.scaleY})`,
    ...(f.blur > 0 ? { filter: `blur(${(f.blur * fontSize).toFixed(2)}px)` } : {}),
  };
  const block = f.pixelate > 0 ? Math.max(2, Math.round(f.pixelate * fontSize)) : 0;
  const content: React.CSSProperties = {
    display: "inline-block",
    opacity: f.textOpacity,
    clipPath: clipPathOf(f.clip),
    ...(block ? { filter: `url(#${filterId})` } : {}),
  };

  let body: React.ReactNode;
  if (f.stickers && f.words) {
    body = <Stickers words={words} parts={f.words} face={face} color={color} />;
  } else if (f.stroke) {
    // The outline traced left to right, then the fill rising into it from the bottom.
    const stroke = Math.max(1, fontSize * 0.022);
    body = (
      // Both layers in one grid cell, so they wrap and sit exactly alike.
      <span style={{ display: "inline-grid" }}>
        <span style={{ ...face, gridArea: "1 / 1", color: "transparent", textShadow: "none", WebkitTextStroke: `${stroke.toFixed(1)}px ${color}`, clipPath: `inset(-50% ${((1 - f.stroke.draw) * 100).toFixed(2)}% -50% -50%)` }}>{text}</span>
        <span aria-hidden style={{ ...face, gridArea: "1 / 1", clipPath: `inset(${((1 - f.stroke.fill) * 100).toFixed(2)}% -50% -50% -50%)` }}>{text}</span>
      </span>
    );
  } else if (f.led) {
    // LED dots: the type seen through a grid of round holes, glowing in its own colour, scrolled in inside its box.
    const holes = "radial-gradient(circle at center, #000 0.034em, transparent 0.046em)";
    body = (
      <span style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top" }}>
        <span style={{ ...face, display: "inline-block", transform: `translateX(${(f.ledShift * 100).toFixed(2)}%)`, maskImage: holes, WebkitMaskImage: holes, maskSize: "0.1em 0.1em", WebkitMaskSize: "0.1em 0.1em", filter: `drop-shadow(0 0 ${(fontSize * 0.06).toFixed(1)}px ${color})` }}>{text}</span>
      </span>
    );
  } else if (f.letters) {
    body = <Letters text={text} parts={f.letters} face={face} />;
  } else {
    body = <span style={face}>{text}</span>;
  }

  return (
    <span style={outer}>
      {block ? <MosaicFilter id={filterId} block={block} /> : null}
      {f.decor.filter((d): d is Extract<EffectDecor, { kind: "ghost" }> => d.kind === "ghost").map((ghost, i) => (
        <span key={`ghost-${i}`} aria-hidden style={{ ...face, position: "absolute", inset: 0, opacity: ghost.opacity * f.textOpacity, transform: `translate(${ghost.x}em, ${ghost.y}em) scale(${ghost.scale / Math.max(0.01, f.scale)})`, transformOrigin: "50% 50%" }}>{text}</span>
      ))}
      <span style={content}>{body}</span>
      <Decorations decor={f.decor} color={color} fontSize={fontSize} boxWidth={boxWidth} />
    </span>
  );
};

/** Each character in its own box, words kept together so a wrapped line never breaks inside one. */
const Letters: React.FC<{ text: string; parts: PartState[]; face: React.CSSProperties }> = ({ text, parts, face }) => {
  const out: React.ReactNode[] = [];
  let word: React.ReactNode[] = [];
  const flush = (key: string) => {
    if (word.length) out.push(<span key={key} style={{ display: "inline-block", whiteSpace: "nowrap" }}>{word}</span>);
    word = [];
  };
  Array.from(text).forEach((char, i) => {
    const part = parts[i] ?? parts[parts.length - 1];
    if (char === "\n") { flush(`w${i}`); out.push(<br key={`br${i}`} />); return; }
    const letter = (
      <span key={`c${i}`} style={{ ...face, display: "inline-block", whiteSpace: "pre", opacity: part.opacity, transform: `translate(${part.x}em, ${part.y}em) rotate(${part.rotate}deg) scale(${part.scale})`, transformOrigin: "50% 70%" }}>
        {char === " " ? " " : char}
      </span>
    );
    if (char === " ") { flush(`w${i}`); out.push(letter); } else word.push(letter);
  });
  flush("w-end");
  return <>{out}</>;
};

/** Relative luminance of a #rrggbb colour, 0..1 (other colours read as light). */
function luminance(color: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return 1;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => { const c = parseInt(h, 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Each word on a label the title's colour, its letters in black or white, whichever reads, stacked one above the next. */
const Stickers: React.FC<{ words: string[]; parts: PartState[]; face: React.CSSProperties; color: string }> = ({ words, parts, face, color }) => {
  const ink = luminance(color) > 0.45 ? "#111111" : "#ffffff";
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: "0.06em" }}>
      {words.map((word, k) => {
        const part = parts[k] ?? parts[parts.length - 1];
        return (
          <span key={k} style={{ ...face, color: ink, textShadow: "none", background: color, padding: "0.04em 0.22em", borderRadius: "0.12em", lineHeight: 1.05, boxShadow: "0 0.06em 0.14em rgba(0,0,0,0.35)", opacity: part.opacity, transform: `translate(${part.x}em, ${part.y}em) rotate(${part.rotate}deg) scale(${part.scale})` }}>
            {word}
          </span>
        );
      })}
    </span>
  );
};

/** The mosaic: the classic flood, tile and dilate filter, `block` px squares. */
const MosaicFilter: React.FC<{ id: string; block: number }> = ({ id, block }) => (
  <svg aria-hidden width="0" height="0" style={{ position: "absolute" }}>
    <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
      <feFlood x={block / 2} y={block / 2} height="1" width="1" />
      <feComposite width={block} height={block} />
      <feTile result="grid" />
      <feComposite in="SourceGraphic" in2="grid" operator="in" />
      <feMorphology operator="dilate" radius={block / 2} />
    </filter>
  </svg>
);

/** Dots, lines, rings and pixels over the box: x is a fraction of `boxWidth`, y em from the box's vertical centre. */
const Decorations: React.FC<{ decor: EffectDecor[]; color: string; fontSize: number; boxWidth: number }> = ({ decor, color, fontSize, boxWidth }) => {
  const drawn = decor.filter((d) => d.kind !== "ghost");
  if (drawn.length === 0) return null;
  const px = (fraction: number) => fraction * boxWidth;
  const em = (value: number) => value * fontSize;
  return (
    // One px tall, centred on the line: an SVG of zero height is not drawn at all (the SVG spec), overflow shows the rest.
    <svg aria-hidden width={boxWidth} height={1} viewBox={`0 -0.5 ${Math.max(1, boxWidth)} 1`} preserveAspectRatio="none" style={{ position: "absolute", left: 0, top: "calc(50% - 0.5px)", width: boxWidth, height: 1, overflow: "visible", pointerEvents: "none" }}>
      {drawn.map((d, i) => {
        if (d.kind === "dot") {
          if (d.opacity <= 0 || d.r <= 0) return null;
          return <ellipse key={i} cx={px(d.x)} cy={em(d.y)} rx={em(d.r) * d.stretch} ry={em(d.r)} fill={color} opacity={d.opacity} />;
        }
        if (d.kind === "line") {
          if (d.opacity <= 0) return null;
          return (
            <g key={i} opacity={d.opacity}>
              <path d={wavePath(px(d.x0), px(d.x1), em(d.y), em(d.amplitude), d.phase)} stroke={color} strokeWidth={em(d.thickness)} strokeLinecap="round" fill="none" />
              {d.head !== null ? <rect x={px(d.head) - em(0.025)} y={em(d.y) - em(0.16)} width={em(0.05)} height={em(0.32)} rx={em(0.025)} fill={color} /> : null}
            </g>
          );
        }
        if (d.kind === "ring") {
          if (d.opacity <= 0 || d.sweep <= 0) return null;
          // An ellipse a little larger than the line, drawn as a dashed stroke whose visible part grows.
          const rx = boxWidth / 2 + em(0.35), ry = em(0.75);
          const length = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
          const angle = (d.rotate * Math.PI) / 180 + d.sweep * Math.PI * 2;
          return (
            <g key={i} opacity={d.opacity}>
              <ellipse cx={boxWidth / 2} cy={0} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={Math.max(1, em(0.035))}
                strokeDasharray={`${(length * d.sweep).toFixed(1)} ${length.toFixed(1)}`} transform={`rotate(${d.rotate} ${boxWidth / 2} 0)`} />
              <circle cx={boxWidth / 2 + rx * Math.cos(angle)} cy={ry * Math.sin(angle)} r={em(0.07)} fill={color} />
            </g>
          );
        }
        if (d.kind === "pixels") {
          const size = em(d.size);
          return (
            <g key={i} fill={color}>
              {d.items.map((item, k) => (item.opacity > 0 ? <rect key={k} x={px(item.x) - size / 2} y={em(item.y) - size / 2} width={size} height={size} opacity={item.opacity} /> : null))}
            </g>
          );
        }
        return null;
      })}
    </svg>
  );
};
