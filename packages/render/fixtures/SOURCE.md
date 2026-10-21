# Render fixtures

## reader.mp4

Four seconds of a woman reading in an armchair by a hanging fireplace, with a
window behind her: a real person for the person matte, and a real window for
a pinned title (ADR 0053).

- Source: Pexels video id 6984912, by Yaroslav Shuraev, downloaded by the
  owner in October 2026 and re-encoded to 1080×1920 portrait
  (`C:\pex\snow\up\snow-6984912.mp4`, used in the snow-lodge reel).
- Licence: the Pexels licence (https://www.pexels.com/license/): free to use
  and modify, no attribution required. It may not be sold unaltered or
  redistributed as stock on another platform; a test fixture is neither.
- Made with: `ffmpeg -ss 0 -t 4 -i snow-6984912.mp4 -vf "scale=540:960:flags=lanczos,fps=30" -an -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart reader.mp4`
  (0–4 s, 540×960, no audio, about 290 KB).

## baseline/

`frame-<n>.png`: the render smoke's exported MP4 at the first, ¼, ½, ¾ and
last frame of each of its two exported shots, at 270×480 (the comparison
size). Written by `SMOKE_COMPARE=1 SMOKE_BASELINE=update pnpm smoke` on
Windows 10 (Chrome Headless Shell from Remotion 4.0.534) on 2026-10-21.
Fonts and Chrome builds differ between machines, so CI compares against these
in report mode only (ADR 0053); replace them with the CI run's frames
(the `render-acceptance` artefact) before making them strict there.
