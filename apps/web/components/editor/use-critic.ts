import { useEffect, useMemo, useRef, useState } from "react";
import {
  criticSamples,
  critique,
  lumaFromRgba,
  momentAt,
  oneLineWidth,
  letterSpacingEm,
  TITLE_LEADING,
  type CriticFace,
  type CriticFinding,
  type CriticFrame,
  type CriticSample,
  type Measure,
  type TextOverlay,
  type Timeline,
  type TitleFont,
} from "@reelwalk/core";
import { textTreatmentCss } from "@reelwalk/render/reel";
import type { LibraryAsset } from "@/lib/library";
import { timelineFrames } from "./frame-service";
import { readCriticFrames, type CriticFrameEntry } from "./critic-frames";

/**
 * The critic before export (ADR 0062), in the editor: runs while the Export
 * sheet is open. The timeline-only checks answer at once; the frames they
 * read are drawn small through the frame service (ADR 0047), as the
 * composition shows them, and the pixel checks follow. Frames are cached by
 * clip presentation and source time, so after a fix only new moments are read.
 */

/** Small frames: enough for motion, contrast and a thumbnail, cheap to seek and read back on a phone. */
const SAMPLE_WIDTH = 72, SAMPLE_HEIGHT = 128;
/** Frames kept between runs (each about 37 KB of luma plus a small JPEG). */
const MAX_CACHED = 160;

/** `failed` when the checks themselves threw: the sheet then keeps the export check's own warnings. */
export type CriticState = { findings: CriticFinding[]; checking: boolean; thumbs: Record<string, string>; failed?: boolean };

/** A title's font as the renderer styles it. */
function titleFont(text: TextOverlay): TitleFont {
  const css = textTreatmentCss(text);
  return { fontFamily: String(css.fontFamily ?? ""), fontWeight: css.fontWeight, fontSize: Number(css.fontSize) || 64, letterSpacing: text.tracking ?? letterSpacingEm(css.letterSpacing), fontStretch: css.fontStretch ? String(css.fontStretch) : undefined };
}
/** Lines measured in the DOM with the title's own font, as the composition measures them. */
const measure: Measure = (line, font) => ({ width: oneLineWidth(line, font) * 1080, height: font.fontSize * TITLE_LEADING });

/** What a frame depends on: the clip as presented (window, speed, fit, zoom, move, grade) and the source time. */
const frameKey = (timeline: Timeline, sample: CriticSample) => `${sample.key}|${JSON.stringify(timeline.clips.find((clip) => clip.id === sample.clipId) ?? null)}`;

export function useCritic({ timeline, library, active, headline, sourceDurationsMs }: {
  timeline: Timeline;
  library: Record<string, LibraryAsset>;
  active: boolean;
  /** The reel's name, offered as an opening title. */
  headline: string | null;
  sourceDurationsMs: () => Record<string, number | null | undefined>;
}): CriticState {
  const frames = useRef(new Map<string, CriticFrameEntry>());
  // Sources that could not be read while this sheet is open: skipped by every later run, retried next time it opens.
  const failedSources = useRef(new Set<string>());
  useEffect(() => { if (!active) failedSources.current.clear(); }, [active]);
  const [state, setState] = useState<CriticState>({ findings: [], checking: false, thumbs: {} });
  const [faces, setFaces] = useState<CriticFace[]>([]);

  // The AI takes in the reel: their face facts come from the server (the identity gate's record).
  const aiAssets = useMemo(() => [...new Set(timeline.clips.map((clip) => clip.assetId).filter((id) => library[id]?.isAiGenerated))].sort().join(","), [timeline.clips, library]);
  useEffect(() => {
    if (!active || !aiAssets) { setFaces([]); return; }
    let live = true;
    fetch(`/api/ai/faces?assets=${encodeURIComponent(aiAssets)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { faces: [] }))
      .then((body: { faces?: CriticFace[] }) => { if (live) setFaces(body.faces ?? []); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [active, aiAssets]);

  const assets = useMemo(() => Object.fromEntries(Object.values(library).map((asset) => [asset.id, { src: asset.url, kind: asset.kind, durationMs: asset.durationMs }])), [library]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const cache = frames.current;
    const input = { timeline, titleFont, measure, faces, headline, sourceDurationsMs: sourceDurationsMs() };
    const samples = criticSamples(timeline);
    const known = () => {
      const map = new Map<string, CriticFrame>();
      for (const sample of samples) {
        const hit = cache.get(frameKey(timeline, sample));
        if (hit) map.set(sample.key, hit.frame);
      }
      return map;
    };
    const thumbsFor = (findings: CriticFinding[]) => Object.fromEntries(findings.flatMap((finding) => {
      const moment = momentAt(timeline, finding.atMs);
      const thumb = moment ? cache.get(frameKey(timeline, moment))?.thumb : null;
      return thumb ? [[finding.id, thumb]] : [];
    }));
    const missing = samples.filter((sample) => !cache.has(frameKey(timeline, sample)));
    // The critic is advice: if it fails, the Export sheet works as it did without it.
    const check = () => {
      try {
        return critique({ ...input, frames: known() });
      } catch (error) {
        console.warn("critic failed", error);
        return null;
      }
    };
    const first = check();
    if (!first) { setState({ findings: [], checking: false, thumbs: {}, failed: true }); return; }
    setState({ findings: first, checking: missing.length > 0, thumbs: thumbsFor(first) });

    const service = timelineFrames(timeline, assets);
    const clipSource = new Map(timeline.clips.map((clip) => [clip.id, assets[clip.assetId]?.src ?? null]));
    const run = (list: CriticSample[]) => readCriticFrames(list, {
      keyOf: (sample) => frameKey(timeline, sample),
      sourceOf: (sample) => clipSource.get(sample.clipId) ?? null,
      cache,
      failed: failedSources.current,
      draw: (sample) => service.frameAt(sample.clipId, sample.sourceMs, { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT, purpose: "view" }),
      // Read at once: the frame service frees canvases it evicts. A tainted canvas (no CORS) throws here.
      read: (canvas) => {
        const ctx = canvas.getContext("2d");
        if (!ctx || !canvas.width) throw new Error("The frame could not be read.");
        return { frame: lumaFromRgba(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height), thumb: canvas.toDataURL("image/jpeg", 0.7) };
      },
      live: () => live,
      maxCached: MAX_CACHED,
    });
    (async () => {
      // By clip and time, so each source is seeked forwards once.
      if ((await run([...missing].sort((a, b) => a.clipId.localeCompare(b.clipId) || a.sourceMs - b.sourceMs))).cancelled) return;
      const findings = check();
      if (!findings) { setState({ findings: [], checking: false, thumbs: {}, failed: true }); return; }
      // Every finding gets a picture of its moment.
      const moments = findings.flatMap((finding) => { const moment = momentAt(timeline, finding.atMs); return moment ? [moment] : []; });
      if ((await run(moments)).cancelled) return;
      setState({ findings, checking: false, thumbs: thumbsFor(findings) });
    })().catch(() => { if (live) setState((current) => ({ ...current, checking: false })); });
    return () => { live = false; };
  }, [active, timeline, faces, headline, assets, sourceDurationsMs]);

  return active ? state : { findings: [], checking: false, thumbs: {} };
}
