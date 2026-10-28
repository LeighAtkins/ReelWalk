import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  areaText,
  baseWindow,
  blockSvg,
  BUILDS,
  blockCameraAt,
  drawBlock,
  footprintCorners,
  groundHit,
  initialPin,
  OUTPUT,
  parseBlockSolve,
  placeAt,
  projectPoint,
  PUSH_IN,
  pushProgress,
  groundYAt,
  pushInFor,
  MIN_REVEAL_SECONDS,
  REVEAL,
  revealBeats,
  revealDurationMs,
  revealFps,
  scaleFromAltitude,
  scaleFromLength,
  suggestSite,
  viewAt,
  type BlockPin,
  type BlockSolve,
  type Vec3,
} from "../src/walk-block";

// The solve of the clip the method was proven on (Pexels 14194694), written by apps/worker/block/run.py: 72 cameras,
// 1,500 of its points, the first camera assumed 60 m up.
const raw = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "block-solve-14194694.json"), "utf8"));
const parsed = parseBlockSolve(raw);
if (!parsed.ok) throw new Error("fixture does not parse");
const solve: BlockSolve = parsed.solve;
/** The prototype measured this flight at 92 m (road 6 m, power pole 9.8 m): true metres per solve metre. */
const TRUE = 92 / 60;

function pinAt(x: number, z: number, extra: Partial<BlockPin> = {}): BlockPin {
  return { build: "home", x, z, yawDeg: 51.5, length: 24, width: 11, cropX: 0.3, sun: { azimuthDeg: 137, elevationDeg: 27 }, scale: { factor: TRUE, basis: "measured" }, ...extra };
}

describe("parseBlockSolve", () => {
  it("reads a solve and a refusal", () => {
    expect(solve.cameras).toHaveLength(72);
    expect(solve.scale.basis).toBe("assumed");
    const refused = parseBlockSolve({ version: 1, ok: false, code: "no-parallax", message: "The drone turns on the spot." });
    expect(refused).toEqual({ ok: false, code: "no-parallax", message: "The drone turns on the spot." });
    expect(parseBlockSolve({ version: 1, ok: true }).ok).toBe(false);
  });
});

describe("cameras", () => {
  it("returns the solved camera at a solved moment and interpolates between", () => {
    const c = blockCameraAt(solve, solve.cameras[10].t);
    expect(c.C).toEqual(solve.cameras[10].C);
    const mid = blockCameraAt(solve, (solve.cameras[10].t + solve.cameras[11].t) / 2);
    for (let k = 0; k < 3; k++) expect(mid.C[k]).toBeCloseTo((solve.cameras[10].C[k] + solve.cameras[11].C[k]) / 2, 6);
    // a proper rotation
    const R = mid.R;
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    expect(det).toBeCloseTo(1, 6);
  });

  it("casts a pixel onto the ground and projects it back", () => {
    const cam = blockCameraAt(solve, 3.3);
    const hit = groundHit(cam, 700, 800)!;
    expect(hit[1]).toBeCloseTo(0, 6);
    const back = projectPoint(cam, hit);
    expect(back.u).toBeCloseTo(700, 6);
    expect(back.v).toBeCloseTo(800, 6);
    expect(groundHit(cam, 960, 100)).toBeNull(); // the sky
  });

  it("agrees with the prototype's hand-placed house corner", () => {
    // au-land-maya/recon/layout.json: the reveal house's front-left corner, cast from reel-crop pixel (722, 1510) of the
    // real frame at 5.00 s onto the ground of the prototype's own solve, at 92 m scale. This solve is an independent
    // re-run of the port; projected with it the corner must land back on that pixel (686, 849 in 1920 x 1080).
    const corner: Vec3 = [-53.72 / TRUE, -0.21 / TRUE, -293.86 / TRUE];
    const p = projectPoint(blockCameraAt(solve, 5.0), corner);
    expect(Math.abs(p.u - 686.1)).toBeLessThan(6);
    expect(Math.abs(p.v - 849.4)).toBeLessThan(6);
  });
});

describe("scale", () => {
  it("takes a stated drone height", () => {
    expect(scaleFromAltitude(solve, 92)).toBeCloseTo(TRUE, 3);
  });

  it("takes a measured length on the still", () => {
    // Two ground points 4 solve metres apart in front of the drone; the person says they are 6 m apart.
    const cam = blockCameraAt(solve, 0);
    const a = groundHit(cam, 600, 950)!;
    const b: Vec3 = [a[0] + 4, a[1], a[2]];
    const pa = projectPoint(cam, a);
    const pb = projectPoint(cam, b);
    const { width, height } = solve.intrinsics;
    const factor = scaleFromLength(solve, [pa.u / width, pa.v / height], [pb.u / width, pb.v / height], 6)!;
    expect(factor).toBeGreaterThan(1.3);
    expect(factor).toBeLessThan(1.7);
    expect(scaleFromLength(solve, [0.5, 0.05], [0.6, 0.9], 6)).toBeNull(); // above the horizon
  });
});

describe("the frame", () => {
  it("crops 9:16 from the landscape frame and pushes in without leaving it", () => {
    const base = baseWindow(solve, 0.5);
    expect(base.w / base.h).toBeCloseTo(OUTPUT.width / OUTPUT.height, 6);
    expect(base.h).toBeCloseTo(solve.intrinsics.height, 6);
    const pin = pinAt(-48.9 / TRUE, -320.6 / TRUE);
    const dur = revealDurationMs(solve);
    expect(dur).toBe(8000);
    for (const t of [0, 2000, 5000, dur]) {
      const w = viewAt(solve, pin, t);
      expect(w.x).toBeGreaterThanOrEqual(-1e-9);
      expect(w.y).toBeGreaterThanOrEqual(-1e-9);
      expect(w.x + w.w).toBeLessThanOrEqual(solve.intrinsics.width + 1e-9);
      expect(w.y + w.h).toBeLessThanOrEqual(solve.intrinsics.height + 1e-9);
    }
    // this outline is ~320 m out: the push goes as deep as allowed; one already wide on screen is not pushed at all
    const push = pushInFor(solve, pin);
    expect(push).toBeGreaterThan(1.5);
    expect(push).toBeLessThanOrEqual(PUSH_IN.max);
    expect(viewAt(solve, pin, dur).w).toBeCloseTo(base.w / push, 3);
    expect(pushInFor(solve, { ...pin, length: 200, width: 150 })).toBe(1);
  });

  it("never pushes before the outline appears, then settles the house a little low in the middle, filling ~35% of the width", () => {
    // a nearer outline, so the push is not at its cap
    const pin = pinAt(11.46, -197.9, { cropX: 0.5585, yawDeg: 90 });
    const base = baseWindow(solve, pin.cropX);
    const beats = revealBeats(revealDurationMs(solve));
    for (const t of [0, beats.outline[0]]) expect(viewAt(solve, pin, t)).toEqual(base); // no push into empty ground
    expect(pushProgress(solve, beats.outline[0] + 200)).toBeGreaterThan(0);
    const t = beats.clad[0];
    const win = viewAt(solve, pin, t);
    expect(pushProgress(solve, t)).toBe(1);
    const cam = blockCameraAt(solve, t / 1000);
    const toOut = (p: Vec3) => {
      const q = projectPoint(cam, p);
      return [(q.u - win.x) / win.w, (q.v - win.y) / win.h];
    };
    const centre = toOut([pin.x, groundYAt(solve, pin.x, pin.z), pin.z]);
    expect(centre[0]).toBeCloseTo(PUSH_IN.focusX, 2);
    expect(centre[1]).toBeCloseTo(PUSH_IN.focusY, 2);
    // clear of the title (y 0.16) and above the caption zone (0.72)
    expect(centre[1]).toBeGreaterThan(0.3);
    expect(centre[1]).toBeLessThan(0.72);
    const xs = footprintCorners(solve, pin).map((c) => toOut(c)[0]);
    const span = Math.max(...xs) - Math.min(...xs);
    if (pushInFor(solve, pin) < PUSH_IN.max) expect(span).toBeCloseTo(PUSH_IN.span, 2);
    else expect(span).toBeLessThan(PUSH_IN.span);
    // held after: the zoom does not change once the walls are closing
    expect(viewAt(solve, pin, 7000).w).toBeCloseTo(win.w, 6);
  });

  it("compresses the push with the stages on a short clip", () => {
    const pin = pinAt(11.46, -197.9, { cropX: 0.5585, yawDeg: 90 });
    const short = { ...solve, source: { ...solve.source, durationMs: 4800 } };
    const beats = revealBeats(revealDurationMs(short));
    expect(pushProgress(short, beats.clad[0])).toBe(1);
    expect(beats.clad[0]).toBeLessThan(revealDurationMs(short));
    expect(viewAt(short, pin, 0)).toEqual(baseWindow(short, pin.cropX));
  });
});

describe("drawBlock", () => {
  const pin = pinAt(-48.9 / TRUE, -320.6 / TRUE);

  it("draws nothing before the outline starts, then outline, fill and the area", () => {
    expect(drawBlock(solve, pin, 0)).toEqual([]);
    const mid = drawBlock(solve, pin, 1400);
    expect(mid.map((s) => (s.kind === "poly" ? s.role : "label"))).toEqual(["fill", "outline", "label"]);
    const label = mid.find((s) => s.kind === "label")!;
    expect(label.kind === "label" && label.text).toBe("264 m²");
    expect(label.kind === "label" && label.sub).toBe(""); // the dimensions line was unreadable from a drone; just the area
  });

  it("finishes as a shaded white massing with its shadow, showing only the faces turned to the camera", () => {
    const end = drawBlock(solve, pin, 6000);
    const faces = end.filter((s) => s.kind === "poly" && s.role === "face");
    expect(faces.length).toBeGreaterThanOrEqual(2);
    expect(faces.length).toBeLessThanOrEqual(4);
    expect(faces.every((f) => f.kind === "poly" && f.fillOpacity === 1)).toBe(true);
    expect(end.some((s) => s.kind === "poly" && s.role === "shadow")).toBe(true);
    expect(end.some((s) => s.kind === "label")).toBe(false); // the walls have closed over it
    expect(end.some((s) => s.kind === "poly" && (s.role === "frame" || s.role === "roof-frame"))).toBe(false);
    for (const s of end) if (s.kind === "poly") for (const p of s.points) expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
  });

  it("builds it in stages: slab, wall frame, roof trusses, then the walls close", () => {
    const roles = (t: number) => new Set(drawBlock(solve, pin, t).map((s) => (s.kind === "poly" ? s.role : "label")));
    const slabbing = roles(1900);
    expect(slabbing.has("slab")).toBe(true);
    expect(slabbing.has("label")).toBe(true); // the area stays, written on the slab
    expect(roles(2900).has("label")).toBe(true);
    expect(roles(4100).has("label")).toBe(false); // gone as the trusses go on
    expect(roles(2400).has("outline")).toBe(false); // poured over
    expect(slabbing.has("frame")).toBe(false);
    const framing = roles(2900);
    expect(framing.has("frame")).toBe(true);
    expect(framing.has("roof-frame")).toBe(false);
    expect(framing.has("face")).toBe(false);
    const roofing = roles(4100);
    expect(roofing.has("roof-frame")).toBe(true);
    expect(roofing.has("face")).toBe(false);
    const closing = drawBlock(solve, pin, 4950);
    const face = closing.find((s) => s.kind === "poly" && s.role === "face");
    expect(face?.kind === "poly" && face.fillOpacity > 0 && face.fillOpacity < 1).toBe(true);
    expect(closing.some((s) => s.kind === "poly" && s.role === "frame")).toBe(true); // still showing through
    // the studs go up in turn: early in the frame beat, fewer are standing than at its end
    const studs = (t: number) => drawBlock(solve, pin, t).filter((s) => s.kind === "poly" && s.role === "frame").length;
    expect(studs(2400)).toBeLessThan(studs(3400));
    expect(studs(3400)).toBeGreaterThan(40); // 70 m of wall at 1.2 m, plus the plates
  });

  it("locks every stage to the ground and lights it by the pinned sun", () => {
    // the slab's base corner is drawn where that moment's camera sees the footprint corner
    const corners = footprintCorners(solve, pin);
    const cam = blockCameraAt(solve, 2.2);
    const win = viewAt(solve, pin, 2200);
    const at = (p: Vec3) => {
      const q = projectPoint(cam, p);
      return [((q.u - win.x) * OUTPUT.width) / win.w, ((q.v - win.y) * OUTPUT.height) / win.h];
    };
    const slabs = drawBlock(solve, pin, 2200).filter((s) => s.kind === "poly" && s.role === "slab");
    const target = at(corners[0]);
    const nearest = Math.min(...slabs.flatMap((s) => (s.kind === "poly" ? s.points : [])).map((p) => Math.hypot(p[0] - target[0], p[1] - target[1])));
    expect(nearest).toBeLessThan(1e-6);
    // the slab's top turns with the sun's height; a stud's colour with the side of the house the sun is on
    const top = (elevationDeg: number) => {
      const shapes = drawBlock(solve, { ...pin, sun: { ...pin.sun, elevationDeg } }, 2400).filter((s) => s.kind === "poly" && s.role === "slab");
      return shapes.map((s) => (s.kind === "poly" ? s.fill : "")).join();
    };
    expect(top(70)).not.toBe(top(10));
    const studColours = new Set(drawBlock(solve, pin, 3400).filter((s) => s.kind === "poly" && s.role === "frame").map((s) => (s.kind === "poly" ? s.stroke : "")));
    expect(studColours.size).toBeGreaterThan(1);
  });

  it("compresses the stages so a short reveal ends on the finished house", () => {
    const short = revealBeats(4600);
    expect(short.clad[1]).toBeLessThanOrEqual(4600 - 600);
    expect(short.slab[0]).toBeLessThan(short.frame[0]);
    expect(short.frame[1]).toBeLessThanOrEqual(short.roof[0]);
    expect(revealBeats(8000)).toEqual(REVEAL);
  });

  it("keeps the outline on the same ground as the drone flies", () => {
    // Each corner is drawn where the solved camera of that moment sees that ground point, through that moment's crop.
    const corners = footprintCorners(solve, pin);
    // (a land outline stays for the whole clip; a house's is poured over by the slab)
    for (const t of [1500, 4000, 7000]) {
      const shapes = drawBlock(solve, { ...pin, build: "land" }, t);
      const outline = shapes.find((s) => s.kind === "poly" && s.role === "outline");
      if (!outline || outline.kind !== "poly") throw new Error("no outline");
      const cam = blockCameraAt(solve, t / 1000);
      const win = viewAt(solve, pin, t);
      const q = projectPoint(cam, corners[0]);
      expect(outline.points[0][0]).toBeCloseTo(((q.u - win.x) * OUTPUT.width) / win.w, 6);
      expect(outline.points[0][1]).toBeCloseTo(((q.v - win.y) * OUTPUT.height) / win.h, 6);
    }
  });

  it("sizes the outline in true metres", () => {
    const corners = footprintCorners(solve, pin);
    const side = Math.hypot(corners[1][0] - corners[0][0], corners[1][2] - corners[0][2]) * TRUE;
    expect(side).toBeCloseTo(24, 6);
    // at the assumed scale the same 24 m is 24 solve metres
    const assumed = footprintCorners(solve, { ...pin, scale: { factor: 1, basis: "assumed" } });
    expect(Math.hypot(assumed[1][0] - assumed[0][0], assumed[1][2] - assumed[0][2])).toBeCloseTo(24, 6);
  });

  it("keeps the land's area on screen and draws a pool's water", () => {
    const land = drawBlock(solve, { ...pin, build: "land", length: 40, width: 30 }, 6000);
    expect(land.some((s) => s.kind === "label")).toBe(true);
    expect(land.some((s) => s.kind === "poly" && s.role === "face")).toBe(false);
    const pool = drawBlock(solve, { ...pin, build: "pool", length: 14, width: 7 }, 6000);
    const roles = pool.map((s) => (s.kind === "poly" ? s.role : "label"));
    // the deck is the pool's slab; the water is drawn after (on top of) every face of it, so it is actually seen
    expect(roles).toContain("pool");
    expect(roles).toContain("slab");
    expect(roles).not.toContain("frame");
    expect(roles.indexOf("pool")).toBeGreaterThan(roles.lastIndexOf("slab"));
  });
});

describe("short footage", () => {
  const cut = (seconds: number): unknown => ({ ...raw, cameras: raw.cameras.filter((c: { t: number }) => c.t <= seconds) });

  it("refuses a solve too short for the reveal's beats", () => {
    const short = parseBlockSolve(cut(3));
    expect(short.ok).toBe(false);
    expect(!short.ok && short.code).toBe("too-short");
    expect(parseBlockSolve(cut(MIN_REVEAL_SECONDS + 0.4)).ok).toBe(true);
  });

  it("never runs the reveal past the last solved camera or the end of the clip", () => {
    const five = parseBlockSolve(cut(5));
    if (!five.ok) throw new Error("5 s should parse");
    const last = five.solve.cameras[five.solve.cameras.length - 1].t;
    expect(revealDurationMs(five.solve)).toBeLessThanOrEqual(last * 1000);
    expect(revealDurationMs(five.solve)).toBeGreaterThanOrEqual(MIN_REVEAL_SECONDS * 1000);
    // the clip's end, less a margin a resampled decode needs at the end of the file
    expect(revealDurationMs({ ...solve, source: { ...solve.source, durationMs: 6200 } })).toBe(6050);
    expect(revealFps(solve)).toBe(30);
    expect(revealFps({ ...solve, source: { ...solve.source, fps: 23.976 } })).toBeCloseTo(23.976, 6);
    // capped: a 60 or 120 fps drone clip makes a 30 fps reveal
    expect(revealFps({ ...solve, source: { ...solve.source, fps: 60 } })).toBe(30);
    expect(revealFps({ ...solve, source: { ...solve.source, fps: 120 } })).toBe(30);
  });
});

describe("the site and the pin", () => {
  it("suggests open, level ground that stays in the crop for the whole reveal", () => {
    const site = suggestSite(solve, "home", TRUE)!;
    expect(site).not.toBeNull();
    const pin = pinAt(site.x, site.z, { cropX: site.cropX, yawDeg: site.yawDeg });
    const dur = revealDurationMs(solve);
    for (let t = 0; t <= dur; t += 1000) {
      const cam = blockCameraAt(solve, t / 1000);
      const win = baseWindow(solve, site.cropX);
      for (const c of footprintCorners(solve, pin)) {
        const q = projectPoint(cam, c);
        expect(q.u).toBeGreaterThan(win.x);
        expect(q.u).toBeLessThan(win.x + win.w);
        expect(q.v).toBeLessThan(win.h);
      }
    }
  });

  it("starts a pin from the suggestion with the build's size, and places it where a finger drags it", () => {
    const pin = initialPin(solve, "two-storey");
    expect(pin.length).toBe(BUILDS["two-storey"].length);
    const win = baseWindow(solve, pin.cropX);
    const placed = placeAt(solve, win, OUTPUT.width / 2, OUTPUT.height * 0.75)!;
    const cam = blockCameraAt(solve, 0);
    const q = projectPoint(cam, [placed.x, 0, placed.z]);
    expect(((q.u - win.x) * OUTPUT.width) / win.w).toBeCloseTo(OUTPUT.width / 2, 0);
    expect(placeAt(solve, win, OUTPUT.width / 2, 10)).toBeNull();
  });
});

describe("blockSvg", () => {
  it("writes the shapes and escapes the label", () => {
    const pin = pinAt(-48.9 / TRUE, -320.6 / TRUE);
    const svg = blockSvg(drawBlock(solve, pin, 2000));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('stroke-dasharray="22 12"');
    expect(svg).toContain("264 m²");
    const withImage = blockSvg(drawBlock(solve, pin, 1500), OUTPUT, { href: "data:image/png;base64,AA==", width: 9, height: 3 });
    expect(withImage).toContain("<image");
    expect(withImage).not.toContain("<text");
  });

  it("formats the area", () => {
    expect(areaText({ length: 40, width: 30 })).toEqual({ text: "1,200 m²", sub: "40 × 30 m" });
    expect(areaText({ length: 12.5, width: 8 })).toEqual({ text: "100 m²", sub: "12.5 × 8 m" });
  });
});
