/* global process, console, document */
// Regenerates src/font-metrics.ts: the advance width of each character, in em, for the faces the renderer
// draws titles in (packages/render src/reel/look.ts), measured in a headless Chromium with the same
// @fontsource-variable files the composition loads. The server has no DOM, so its title boxes (render
// checks, the hook rules, the critic's fallback) sum these instead of guessing 0.62 em a character.
//
//   node packages/core/scripts/font-metrics.mjs [--playwright <dir of playwright-core>]
//
// playwright-core is not a workspace dependency: pass the directory (pnpm keeps one under
// node_modules/.pnpm/playwright-core@*/node_modules/playwright-core) or have it resolvable.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const pwDir = args.includes("--playwright") ? args[args.indexOf("--playwright") + 1] : null;
const { chromium } = require(pwDir ? resolve(pwDir) : "playwright-core");

/** The fontsource CSS the composition imports (packages/render src/reel/fonts.ts). */
const css = ["@fontsource-variable/archivo/wdth.css", "@fontsource-variable/cormorant-garamond/wght.css", "@fontsource-variable/bodoni-moda/opsz.css"]
  .map((spec) => pathToFileURL(require.resolve(spec, { paths: [resolve(root, "packages/render")] })).href);

/** The faces titles are drawn in: family × the weights look.ts uses × the stretches (Archivo's wdth axis). */
const FACES = [
  { family: "Archivo Variable", weights: [600, 700, 800, 850], stretches: [75, 100, 112, 125] },
  { family: "Cormorant Garamond Variable", weights: [600, 700], stretches: [100] },
  { family: "Bodoni Moda Variable", weights: [600, 700, 800, 850], stretches: [100] },
];
/** Printable ASCII plus the punctuation the owner's titles use. */
const CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), "‘", "’", "“", "”", "…", "·", "–", "—", "×", "é", "è"];

const html = `<!doctype html><html><head><meta charset="utf-8">${css.map((href) => `<link rel="stylesheet" href="${href}">`).join("")}
<style>body{margin:0} #m{position:absolute;left:0;top:0;white-space:pre;font-size:100px;line-height:1}</style></head><body><span id="m"></span></body></html>`;
// A file: page, so the file: stylesheets and their font files load (about:blank may not fetch them).
const dir = mkdtempSync(join(tmpdir(), "reelwalk-font-metrics-"));
const pageFile = join(dir, "measure.html");
writeFileSync(pageFile, html);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(pageFile).href, { waitUntil: "load" });
  const faces = {};
  for (const face of FACES) {
    for (const weight of face.weights) {
      for (const stretch of face.stretches) {
        const loaded = await page.evaluate(async ({ family, weight }) => {
          await document.fonts.load(`${weight} 100px "${family}"`, "abc");
          await document.fonts.ready;
          return [...document.fonts].some((f) => f.family.replace(/^"|"$/g, "") === family && f.status === "loaded");
        }, { family: face.family, weight });
        if (!loaded) throw new Error(`${face.family} ${weight} did not load from ${css.join(", ")}`);
        const widths = await page.evaluate(({ family, weight, stretch, chars }) => {
          const span = document.getElementById("m");
          span.style.fontFamily = `"${family}"`;
          span.style.fontWeight = String(weight);
          span.style.fontStretch = `${stretch}%`;
          const out = {};
          for (const ch of chars) {
            // Ten in a row over ten: sub-pixel advances without a single glyph's rounding.
            span.textContent = ch.repeat(10);
            out[ch] = Math.round((span.getBoundingClientRect().width / 10 / 100) * 1000) / 1000;
          }
          return out;
        }, { family: face.family, weight, stretch, chars: CHARS });
        const letters = CHARS.filter((ch) => /[a-z]/.test(ch));
        const avg = Math.round((letters.reduce((sum, ch) => sum + widths[ch], 0) / letters.length) * 1000) / 1000;
        faces[`${face.family}|${weight}|${stretch}`] = { avg, widths };
        console.log(`${face.family} ${weight} ${stretch}%: lowercase average ${avg} em, "every room in 15 seconds" ${Math.round([..."every room in 15 seconds"].reduce((s, ch) => s + widths[ch], 0) * 76)} px at 76 px`);
      }
    }
  }
  // The three faces must differ from one another and the stretches of Archivo from each other: identical
  // tables mean a fallback face was measured.
  const keys = Object.keys(faces);
  const sameAs = (a, b) => JSON.stringify(faces[a].widths) === JSON.stringify(faces[b].widths);
  if (sameAs("Archivo Variable|700|100", "Cormorant Garamond Variable|700|100") || sameAs("Archivo Variable|700|75", "Archivo Variable|700|125")) {
    throw new Error("the faces measured identically: the fonts did not load");
  }
  const generated = `// Generated by scripts/font-metrics.mjs (${new Date().toISOString().slice(0, 10)}); do not edit by hand.
// Advance widths in em per character for the renderer's title faces, measured in a headless Chromium with the
// same @fontsource-variable files the composition loads. Key: "family|weight|stretch%". See estimateLineWidth.
export const FONT_METRICS: Record<string, { avg: number; widths: Record<string, number> }> = ${JSON.stringify(faces)};
`;
  const target = resolve(here, "../src/font-metrics.ts");
  const before = (() => { try { return readFileSync(target, "utf8"); } catch { return ""; } })();
  writeFileSync(target, generated);
  console.log(`${before === generated ? "unchanged" : "wrote"} ${target} (${keys.length} faces)`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
