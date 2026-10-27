import { useEffect, useState } from "react";
import { continueRender, delayRender } from "remotion";
import "@fontsource-variable/archivo/wdth.css";
// Archivo italic (SIL OFL 1.1): a keyword lockup's caption words (ADR 0089).
import "@fontsource-variable/archivo/wdth-italic.css";
import "@fontsource-variable/noto-sans-jp/wght.css";
// Playfair Display (SIL Open Font Licence 1.1): the "elegant" style and the serif hook since ADR 0083 (the owner's choice).
import "@fontsource-variable/playfair-display/wght.css";
// Cormorant Garamond (SIL Open Font Licence 1.1): the title font "serif", and the elegant style before ADR 0083.
import "@fontsource-variable/cormorant-garamond/wght.css";
import "@fontsource-variable/bodoni-moda/opsz.css";
// Inter Tight (SIL Open Font Licence 1.1): the title font "tight", the heavy grotesk of the focus captions (ADR 0092).
import "@fontsource-variable/inter-tight/wght.css";
// Brand kit fonts (ADR 0078), bundled files with their SIL OFL 1.1 licence texts beside them: declared here, downloaded
// only when a title that uses one asks for it (`useFontsFor`'s `families`).
import "./brand-fonts/brand-fonts.css";

/**
 * The faces are bundled (fontsource's files, no network at render time) and declared by CSS, split by script with
 * unicode-range so a Japanese title fetches only the glyphs it uses. Remotion's local-fonts rule (`loadFont` from
 * @remotion/fonts) does the same hold, one whole file per call; it would lose that split and needs a URL per file
 * from two bundlers (Next's and Remotion's webpack), so the declaration stays CSS and the hold is this hook (ADR 0083).
 *
 * Font files are split by script and only downloaded once a glyph needs them.
 * In the worker a frame could be captured before that finishes and come out in
 * a fallback font, so rendering is held until the glyphs of this text are loaded.
 * In the Player this simply resolves quickly and has no visible effect.
 */
export function useFontsFor(text: string, weight: number, brandFamilies: readonly string[] = [], italic = false): boolean {
  const [handle] = useState(() => delayRender(`Loading fonts for "${text.slice(0, 20)}"`));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sample = text || "A";
    Promise.all([
      document.fonts.load(`${weight} 64px "Archivo Variable"`, sample),
      document.fonts.load(`${weight} 64px "Noto Sans JP Variable"`, sample),
      document.fonts.load(`${weight} 64px "Playfair Display Variable"`, sample),
      document.fonts.load(`${weight} 64px "Cormorant Garamond Variable"`, sample),
      document.fonts.load(`${weight} 64px "Bodoni Moda Variable"`, sample),
      document.fonts.load(`${weight} 64px "Inter Tight Variable"`, sample),
      ...brandFamilies.map((family) => document.fonts.load(`${weight} 64px "${family}"`, sample)),
      ...(italic ? [document.fonts.load(`italic ${weight} 64px "Archivo Variable"`, sample)] : []),
    ])
      .catch(() => undefined)
      .finally(() => {
        // Flip the state first: the component renders once more with the fonts in place (a title measures its
        // lines during render with Remotion's measureText, which caches what it measures, so nothing is measured
        // until `ready`: a fallback font's width would be kept for good); the frame is released after that render.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      continueRender(handle);
    };
  }, [handle, text, weight, brandFamilies.join("|"), italic]);

  useEffect(() => {
    if (ready) continueRender(handle);
  }, [ready, handle]);

  return ready;
}
