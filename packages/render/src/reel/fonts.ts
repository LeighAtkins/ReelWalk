import { useEffect, useState } from "react";
import { continueRender, delayRender } from "remotion";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/noto-sans-jp/wght.css";
// Cormorant Garamond (SIL Open Font Licence 1.1) for the "elegant" text style.
import "@fontsource-variable/cormorant-garamond/wght.css";
import "@fontsource-variable/bodoni-moda/opsz.css";
// Brand kit fonts (ADR 0078), bundled files with their SIL OFL 1.1 licence texts beside them: declared here, downloaded
// only when a title that uses one asks for it (`useFontsFor`'s `families`).
import "./brand-fonts/brand-fonts.css";

/**
 * Font files are split by script and only downloaded once a glyph needs them.
 * In the worker a frame could be captured before that finishes and come out in
 * a fallback font, so rendering is held until the glyphs of this text are loaded.
 * In the Player this simply resolves quickly and has no visible effect.
 */
export function useFontsFor(text: string, weight: number, brandFamilies: readonly string[] = []): boolean {
  const [handle] = useState(() => delayRender(`Loading fonts for "${text.slice(0, 20)}"`));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sample = text || "A";
    Promise.all([
      document.fonts.load(`${weight} 64px "Archivo Variable"`, sample),
      document.fonts.load(`${weight} 64px "Noto Sans JP Variable"`, sample),
      document.fonts.load(`${weight} 64px "Cormorant Garamond Variable"`, sample),
      document.fonts.load(`${weight} 64px "Bodoni Moda Variable"`, sample),
      ...brandFamilies.map((family) => document.fonts.load(`${weight} 64px "${family}"`, sample)),
    ])
      .catch(() => undefined)
      .finally(() => {
        // Flip the state first: the component renders once more with the fonts in place (a planar title
        // measures its line width during render, and a measurement taken in a fallback font would be
        // frozen into the captured frame); the frame is released after that render has committed.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      continueRender(handle);
    };
  }, [handle, text, weight, brandFamilies.join("|")]);

  useEffect(() => {
    if (ready) continueRender(handle);
  }, [ready, handle]);

  return ready;
}
