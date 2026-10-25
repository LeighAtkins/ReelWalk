/**
 * Runs "Put text on a surface" (ADR 0075) end to end on real footage, without the app: ffmpeg reads the
 * frames, the finder proposes surfaces, the tracker follows the best one through the shot with the code the
 * editor's Pin uses, and the result is drawn at three moments of the shot.
 *
 *   tsx scripts/surface-verify.mts --ffmpeg ffmpeg --out tracked.png --json report.json [--regions regions.json]
 *       [--title "THE LODGE"] [--pick auto|wall|floor|sky] [--seconds 2.5] [--placements dir] file.mp4@start[=label] ...
 *
 * `--regions` maps a label to { regions, horizonY }: stand-ins for what the vision call answers, for runs
 * where no model is configured. The `look` here is that file, never a model; the report says which.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import type { Clip, SurfaceHints, SurfacePick } from "@reelwalk/core";
import { placeOnSurface, searchSurfaces, type SurfaceLook } from "../lib/surface-service";
import type { SurfaceSource } from "../lib/surface-server";

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flagged = new Set(["--ffmpeg", "--out", "--json", "--regions", "--title", "--pick", "--seconds", "--placements"]);
const specs = args.filter((a, i) => !a.startsWith("--") && !flagged.has(args[i - 1] ?? ""));
const ffmpeg = option("ffmpeg", "ffmpeg")!;
process.env.FFMPEG = ffmpeg;
const title = option("title", "THE LODGE")!;
const pick = (option("pick", "auto") ?? "auto") as SurfacePick;
const length = Number(option("seconds", "2.5")) * 1000;
const hintsByLabel: Record<string, SurfaceHints> = option("regions") ? JSON.parse(readFileSync(option("regions")!, "utf8")) : {};
const W = 360, H = 640, COLORS = ["#ffb000", "#27c4e8", "#e24bd0"];

function probe(file: string): { width: number; height: number } {
  let text = "";
  try { execFileSync(ffmpeg, ["-hide_banner", "-i", file], { stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { text = String((error as { stderr?: Buffer }).stderr ?? ""); }
  const m = /Stream #[^\n]*Video:[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(text);
  if (!m) throw new Error(`cannot read the size of ${file}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

type Row = { label: string; tracking: string; kind?: string; grade?: string; confidence?: number; points?: number; notes: string[]; candidates: number; ms: number; vision: string };
const report: Row[] = [];
const tiles: Buffer[] = [];
for (const spec of specs) {
  const eq = spec.lastIndexOf("="), target = eq >= 0 ? spec.slice(0, eq) : spec, label = eq >= 0 ? spec.slice(eq + 1) : spec;
  const at = target.lastIndexOf("@"), file = target.slice(0, at), start = Number(target.slice(at + 1)) * 1000;
  const source: SurfaceSource = { src: file, ...probe(file) };
  const clip = { id: "c1", assetId: "a1", kind: "VIDEO", sourceStartMs: start, sourceEndMs: start + length, speed: 1, volume: 1, fit: "cover", filter: "none", motion: "none", zoom: 1, pano: null, spot: null, room: null, transitionIn: "cut" } as Clip;
  const look: SurfaceLook | null = hintsByLabel[label] ? async () => ({ hints: hintsByLabel[label], model: "stand-in labels typed by hand", usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }, costUsd: 0, ms: 0 }) : null;
  const t0 = performance.now();
  const outcome = await placeOnSurface({ source, clip, clipStartMs: 0, text: { text: title }, atMs: 0 }, { pick, look });
  const ms = performance.now() - t0;
  if (outcome.ok && option("placements")) writeFileSync(`${option("placements")}/${label}.placement.json`, JSON.stringify({ file, startMs: start, lengthMs: length, text: title, placement: outcome.placement }));
  const found = await searchSurfaces({ source, clip, clipStartMs: 0, text: { text: title }, atMs: 0 }, { look, top: 3 });
  if (!outcome.ok) { report.push({ label, tracking: "none", notes: [outcome.message], candidates: found.search.candidates.length, ms, vision: look ? "stand-in" : "geometry only" }); }
  else {
    report.push({ label, tracking: outcome.tracking, kind: outcome.candidate.kind, grade: outcome.quality?.grade, confidence: outcome.quality?.confidence, points: outcome.candidate.texture.points, notes: outcome.notes, candidates: found.search.candidates.length, ms, vision: look ? "stand-in" : "geometry only" });
  }
  // Three moments of the shot, with the proposals on the first and the followed corners on each.
  const moments = [0, 0.5, 1].map((share) => start + share * (length - 80));
  const quadAt = (share: number): number[] | null => {
    if (!outcome.ok) return null;
    const path = outcome.placement.pinned?.path;
    if (!path) return outcome.placement.corners;
    const next = path.findIndex((p) => p.t >= share);
    const b = path[Math.max(0, next)], a = path[Math.max(0, next - 1)];
    const w = b.t === a.t ? 0 : (share - a.t) / (b.t - a.t);
    return a.q!.map((v, i) => v + (b.q![i] - v) * w);
  };
  const shots = await Promise.all(moments.map(async (ms2, i) => {
    const frame = execFileSync(ffmpeg, ["-v", "error", "-ss", (ms2 / 1000).toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, "-f", "image2pipe", "-vcodec", "png", "-"], { maxBuffer: 1 << 26 });
    const share = i / 2, q = quadAt(share);
    const polys = [] as string[];
    const poly = (c: readonly number[]) => [0, 1, 2, 3].map((k) => `${(c[k * 2] * W).toFixed(1)},${(c[k * 2 + 1] * H).toFixed(1)}`).join(" ");
    if (i === 0) found.search.candidates.forEach((c, k) => polys.push(`<polygon points="${poly(c.plane)}" fill="none" stroke="${COLORS[k % 3]}" stroke-width="1.5" stroke-dasharray="5 4"/>`));
    if (q) polys.push(`<polygon points="${poly(q)}" fill="#ffb000" fill-opacity="0.4" stroke="#ffb000" stroke-width="2"/>`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${polys.join("")}</svg>`;
    return sharp(frame).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  }));
  const row = report[report.length - 1];
  const caption = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 3 + 8}" height="46"><rect width="100%" height="100%" fill="#14110d"/><text x="8" y="19" font-family="sans-serif" font-size="14" font-weight="700" fill="#f4eee2">${label}: ${row.kind ?? "none"}, ${row.tracking}${row.grade ? `, ${row.grade} track` : ""}</text><text x="8" y="38" font-family="sans-serif" font-size="12" fill="#c9bfa8">start / middle / end of the shot${row.vision === "stand-in" ? " (labels: hand-typed stand-in)" : " (geometry only)"}</text></svg>`;
  tiles.push(await sharp({ create: { width: W * 3 + 8, height: H + 46, channels: 3, background: "#0b0907" } }).composite([{ input: Buffer.from(caption), top: 0, left: 0 }, ...shots.map((input, i) => ({ input, top: 46, left: i * (W + 4) }))]).png().toBuffer());
}
const gap = 8, height = tiles.length ? (H + 46 + gap) * tiles.length : 10;
const cols = 2, rows = Math.ceil(tiles.length / cols);
await sharp({ create: { width: cols * (W * 3 + 8 + gap) + gap, height: rows * (H + 46 + gap) + gap, channels: 3, background: "#0b0907" } })
  .composite(tiles.map((input, i) => ({ input, left: gap + (i % cols) * (W * 3 + 8 + gap), top: gap + Math.floor(i / cols) * (H + 46 + gap) }))).png().toFile(option("out", "tracked.png")!);
void height;
if (option("json")) writeFileSync(option("json")!, JSON.stringify(report, null, 2));
console.table(report.map((r) => ({ label: r.label, vision: r.vision, kind: r.kind, tracking: r.tracking, grade: r.grade, conf: r.confidence, points: r.points, ms: Math.round(r.ms) })));
for (const r of report) console.log(`- ${r.label}: ${r.notes.join(" ")}`);
