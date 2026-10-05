import { useEffect, useState } from "react";
import { continueRender, delayRender } from "remotion";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/noto-sans-jp/wght.css";

/**
 * Font files are split by script and only downloaded once a glyph needs them.
 * In the worker a frame could be captured before that finishes and come out in
 * a fallback font, so rendering is held until the glyphs of this text are loaded.
 * In the Player this simply resolves quickly and has no visible effect.
 */
export function useFontsFor(text: string, weight: number): void {
  const [handle] = useState(() => delayRender(`Loading fonts for "${text.slice(0, 20)}"`));

  useEffect(() => {
    let cancelled = false;
    const sample = text || "A";
    Promise.all([
      document.fonts.load(`${weight} 64px "Archivo Variable"`, sample),
      document.fonts.load(`${weight} 64px "Noto Sans JP Variable"`, sample),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) continueRender(handle);
      });
    return () => {
      cancelled = true;
      continueRender(handle);
    };
  }, [handle, text, weight]);
}
