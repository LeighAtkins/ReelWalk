// make-sfx.mjs — synthesise a small sound-effects set for a video editor.
// Usage: node make-sfx.mjs <outDir>
// Plain Node ESM, no dependencies, no network. Deterministic (seeded PRNG).
// Output: PCM 16-bit mono 32 000 Hz WAV files.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SR = 32000;
const outDir = resolve(process.argv[2] ?? 'out');
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const white = (rnd) => rnd() * 2 - 1;

// ---------------------------------------------------------------- RBJ biquad
class Biquad {
  constructor(type, f0, Q) {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(type, f0, Q);
  }
  set(type, f0, Q) {
    f0 = Math.min(Math.max(f0, 10), SR * 0.45);
    const w0 = (2 * Math.PI * f0) / SR;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; } // constant 0 dB peak gain
    else throw new Error('unknown filter type ' + type);
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
const RECOMPUTE = 64; // samples between coefficient updates for swept filters

// ---------------------------------------------------------------- Pink noise (Paul Kellet)
class Pink {
  constructor(rnd) { this.rnd = rnd; this.b = new Float64Array(7); }
  run() {
    const w = white(this.rnd), b = this.b;
    b[0] = 0.99886 * b[0] + w * 0.0555179;
    b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.96900 * b[2] + w * 0.1538520;
    b[3] = 0.86650 * b[3] + w * 0.3104856;
    b[4] = 0.55000 * b[4] + w * 0.5329522;
    b[5] = -0.7616 * b[5] - w * 0.0168980;
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
    b[6] = w * 0.115926;
    return out * 0.11;
  }
}

// ---------------------------------------------------------------- Slow random LFO (0..1)
// Picks a new random target every minHold..maxHold seconds and glides to it (one-pole).
class SlowRandom {
  constructor(rnd, minHold, maxHold, smoothSec, start = 0.5) {
    this.rnd = rnd; this.minHold = minHold; this.maxHold = maxHold;
    this.k = 1 - Math.exp(-1 / (smoothSec * SR));
    this.value = start; this.target = start; this.left = 0;
  }
  run() {
    if (this.left <= 0) {
      this.target = this.rnd();
      this.left = Math.round((this.minHold + (this.maxHold - this.minHold) * this.rnd()) * SR);
    }
    this.left--;
    this.value += (this.target - this.value) * this.k;
    return this.value;
  }
}

// ---------------------------------------------------------------- helpers
const ms = (x) => Math.round((x / 1000) * SR);
const expSweep = (a, b, u) => a * Math.pow(b / a, u);
const dB = (x) => Math.pow(10, x / 20);

function dcBlock(buf) {
  const hp = new Biquad('hp', 20, Math.SQRT1_2);
  for (let i = 0; i < buf.length; i++) buf[i] = hp.run(buf[i]);
  return buf;
}
// First-order 20 Hz DC blocker (y = x - x1 + R*y1). Used for the impact: the 2nd-order
// Butterworth's oscillatory onset transient would otherwise cut the first half-cycle of a
// sine that starts at t = 0 and push the peak sample to the second half-cycle.
function dcBlock1(buf, fc = 20) {
  const R = 1 - (2 * Math.PI * fc) / SR;
  let x1 = 0, y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const y = buf[i] - x1 + R * y1;
    x1 = buf[i]; y1 = y; buf[i] = y;
  }
  return buf;
}
function normalise(buf, peakDb) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const g = peak > 0 ? dB(peakDb) / peak : 1;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}
function fade(buf, inMs, outMs) {
  const nIn = ms(inMs), nOut = ms(outMs), N = buf.length;
  for (let i = 0; i < nIn; i++) buf[i] *= i / nIn;
  for (let i = 0; i < nOut; i++) buf[N - 1 - i] *= i / nOut;
  return buf;
}
// Equal-power crossfade of the last xf samples into the first xf samples, then cut to loopLen.
function loopify(buf, loopLen, xf) {
  const out = new Float64Array(loopLen);
  for (let i = 0; i < loopLen; i++) out[i] = buf[i];
  for (let i = 0; i < xf; i++) {
    const u = i / xf;
    const gIn = Math.sin((Math.PI / 2) * u);   // head rises
    const gOut = Math.cos((Math.PI / 2) * u);  // tail falls
    out[i] = buf[i] * gIn + buf[loopLen + i] * gOut;
  }
  return out;
}
function writeWav(path, buf) {
  const n = buf.length;
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    data.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, data);
}

// ---------------------------------------------------------------- 1. Whooshes
// White noise -> swept band-pass (Q ~2), plus a wider "air" band-pass at lower gain.
// A short RMS leveller flattens the noise's own loudness so the amplitude envelope
// (peaking at exactly 300 ms) decides where the peak sample lands.
function whoosh(seed, sweep /* (u)=>Hz */) {
  const rnd = mulberry32(seed);
  const N = ms(700), peakAt = 0.3, end = 0.7;
  const core = new Biquad('bp', sweep(0), 2.0);
  const air = new Biquad('bp', sweep(0) * 1.6, 0.8);
  const pre = ms(100);
  const out = new Float64Array(N);
  let rms = 0;
  const kRms = 1 - Math.exp(-1 / (0.010 * SR));
  for (let j = -pre; j < N; j++) {
    const i = Math.max(0, j);
    if (j % RECOMPUTE === 0 || j === -pre) {
      const f = sweep(i / N);
      core.set('bp', f, 2.0);
      air.set('bp', f * 1.6, 0.8);
    }
    const w = white(rnd);
    const s = core.run(w) + air.run(w) * dB(-10);
    rms += (s * s - rms) * kRms;
    const lev = s / Math.sqrt(rms + 1e-9);
    if (j < 0) continue;
    const t = j / SR;
    let env;
    if (t < peakAt) { const u = t / peakAt; env = u * u * u; }
    else { const v = (t - peakAt) / (end - peakAt); env = (1 - v) * (1 - v) * Math.exp(-4 * v); }
    out[j] = lev * env;
  }
  dcBlock(out);
  fade(out, 5, 5);
  return normalise(out, -3);
}

// ---------------------------------------------------------------- 2. Riser
function riser(seed) {
  const rnd = mulberry32(seed);
  const N = ms(3000);
  const lp = new Biquad('lp', 150, 1.0);
  const out = new Float64Array(N);
  const detune = [1.0, 1.006, 0.9945];
  const ph = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    if (i % RECOMPUTE === 0) lp.set('lp', expSweep(150, 9000, u), 1.0);
    const noise = lp.run(white(rnd));
    const f = 110 * Math.pow(2, u);
    let tone = 0;
    for (let k = 0; k < 3; k++) {
      ph[k] += (2 * Math.PI * f * detune[k]) / SR;
      tone += Math.sin(ph[k]);
    }
    tone /= 3;
    const amp = 0.015 + 0.985 * Math.pow(u, 2.2);
    out[i] = (noise * 0.9 + tone * 0.35) * amp;
  }
  dcBlock(out);
  fade(out, 5, 1.5); // the end is the hit point; only a 1.5 ms de-click at the tail
  return normalise(out, -3);
}

// ---------------------------------------------------------------- 3. Soft impact
function impactSoft(seed) {
  const rnd = mulberry32(seed);
  const N = ms(900);
  const out = new Float64Array(N);
  const tau = 0.6 / 6.9; // ~ -60 dB at 600 ms
  const click = new Biquad('bp', 1800, 1.0);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = t < 0.25 ? expSweep(70, 38, t / 0.25) : 38;
    ph += (2 * Math.PI * f) / SR;
    const punch = 1 + 1.5 * Math.exp(-t / 0.004); // lets the first half-cycle (~3.6 ms) carry the peak
    const body = Math.sin(ph) * Math.exp(-t / tau) * punch;
    let c = 0;
    if (t < 0.02) {
      const att = Math.min(1, t / 0.0005);
      c = click.run(white(rnd)) * att * Math.exp(-t / 0.005) * 0.12;
    }
    out[i] = body + c;
  }
  dcBlock1(out);
  fade(out, 0.5, 5); // sine starts at a zero crossing; a 5 ms head fade would dull the 0-10 ms peak
  return normalise(out, -1);
}

// ---------------------------------------------------------------- loop scaffolding
// Generates warm-up + seek window + lenMs + xfMs, DC-blocks the whole thing, then picks the
// start offset (within the seek window) whose loop seam (sample L-1 -> sample L of the trimmed
// buffer, which become last -> first after the crossfade) has the smallest step and sits near
// a zero crossing. Deterministic, keeps the loop at exactly lenMs.
function makeLoop(seed, gen, peakDb, lenMs = 4000, xfMs = 500, warmMs = 250, seekMs = 50) {
  const rnd = mulberry32(seed);
  const L = ms(lenMs), xf = ms(xfMs), warm = ms(warmMs), seek = ms(seekMs);
  const buf = new Float64Array(warm + seek + L + xf);
  gen(rnd, buf);
  dcBlock(buf);
  let peak = 0;
  for (let i = warm; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  let best = 0, bestScore = Infinity;
  for (let o = 0; o < seek; o++) {
    const a = buf[warm + o + L - 1], b = buf[warm + o + L];
    const score = Math.abs(b - a) + 0.5 * Math.abs(b) + 0.5 * Math.abs(a);
    if (score < bestScore) { bestScore = score; best = o; }
  }
  const trimmed = buf.subarray(warm + best, warm + best + L + xf);
  const looped = loopify(trimmed, L, xf);
  return normalise(looped, peakDb);
}

// ---------------------------------------------------------------- 4. Fire
function fireGen(rnd, buf) {
  const N = buf.length;
  const lp = new Biquad('lp', 250, 0.8);
  const hp = new Biquad('hp', 2500, 0.8);
  const mod = new SlowRandom(rnd, 0.2, 0.9, 0.25);
  let brown = 0;
  // crackle scheduling
  const crackles = new Float64Array(N);
  let i = 0;
  let clusterLeft = 0;
  while (i < N) {
    const rate = clusterLeft > 0 ? 110 : 26; // per second; clusters are denser
    const gap = -Math.log(1 - rnd()) / rate;
    i += Math.max(1, Math.round(gap * SR));
    if (i >= N) break;
    if (clusterLeft > 0) clusterLeft -= Math.round(gap * SR);
    else if (rnd() < 0.08) clusterLeft = ms(60 + rnd() * 120);
    const durMs = 2 + rnd() * 6;
    const dur = ms(durMs);
    const r = rnd();
    const amp = 0.08 + 0.92 * r * r * r;
    const tail = ms(3);
    for (let k = 0; k < dur + tail && i + k < N; k++) {
      const t = k / SR;
      const att = Math.min(1, t / 0.0002);
      const rel = k < dur ? 1 : Math.exp(-(k - dur) / (tail / 4));
      crackles[i + k] += white(rnd) * att * Math.exp(-t / 0.015) * rel * amp;
    }
  }
  for (let n = 0; n < N; n++) {
    brown += white(rnd) * 0.03;
    brown -= brown * 0.003;
    const rumble = lp.run(brown) * (0.55 + 0.45 * mod.run());
    const crack = hp.run(crackles[n]);
    buf[n] = rumble * 0.9 + crack * 0.55;
  }
}

// ---------------------------------------------------------------- 5. Water
function waterGen(rnd, buf) {
  const N = buf.length;
  const bp = new Biquad('bp', 1400, 0.9);
  const hpLim = new Biquad('hp', 600, Math.SQRT1_2);
  const lpLim = new Biquad('lp', 3000, Math.SQRT1_2);
  const lfoF = new SlowRandom(rnd, 0.4, 1.5, 0.35);
  const lfoA = new SlowRandom(rnd, 0.3, 1.2, 0.3);
  // bubbles
  const bubbles = new Float64Array(N);
  let i = 0;
  while (i < N) {
    const gap = -Math.log(1 - rnd()) / 3; // ~3 per second
    i += Math.max(1, Math.round(gap * SR));
    if (i >= N) break;
    const len = ms(60);
    const amp = 0.15 + 0.35 * rnd();
    let ph = 0;
    for (let k = 0; k < len && i + k < N; k++) {
      const t = k / SR, u = k / len;
      ph += (2 * Math.PI * expSweep(1800, 900, u)) / SR;
      const att = Math.min(1, t / 0.001);
      bubbles[i + k] += Math.sin(ph) * att * Math.exp(-t / 0.014) * amp;
    }
  }
  for (let n = 0; n < N; n++) {
    const fc = lfoF.run();
    if (n % RECOMPUTE === 0) bp.set('bp', expSweep(800, 2200, fc), 0.9);
    const level = 0.55 + 0.45 * lfoA.run();
    const s = lpLim.run(hpLim.run(bp.run(white(rnd)))) * level;
    buf[n] = s + bubbles[n];
  }
}

// ---------------------------------------------------------------- 6. Wind
function windGen(rnd, buf) {
  const N = buf.length;
  const pink = new Pink(rnd);
  const lp = new Biquad('lp', 400, 2.5);
  const lfoF = new SlowRandom(rnd, 0.8, 2.5, 0.9);
  const lfoA = new SlowRandom(rnd, 1.0, 3.0, 0.8);
  for (let n = 0; n < N; n++) {
    const f = lfoF.run();
    if (n % RECOMPUTE === 0) lp.set('lp', expSweep(200, 900, f), 2.5);
    const level = 0.35 + 0.65 * lfoA.run();
    buf[n] = lp.run(pink.run()) * level;
  }
}

// ---------------------------------------------------------------- 7. Room tone
function roomGen(rnd, buf) {
  const pink = new Pink(rnd);
  const lp = new Biquad('lp', 2000, Math.SQRT1_2);
  for (let n = 0; n < buf.length; n++) buf[n] = lp.run(pink.run());
}

// ---------------------------------------------------------------- render
const files = [
  ['whoosh-1.wav', () => whoosh(0x5f1e01, (u) => expSweep(400, 4000, u))],
  ['whoosh-2.wav', () => whoosh(0x5f1e02, (u) => expSweep(3500, 500, u))],
  ['whoosh-3.wav', () => whoosh(0x5f1e03, (u) => (u < 0.5 ? expSweep(600, 2500, u * 2) : expSweep(2500, 800, (u - 0.5) * 2)))],
  ['riser.wav', () => riser(0x7a11e0)],
  ['impact-soft.wav', () => impactSoft(0x1a4ac7)],
  ['fire.wav', () => makeLoop(0xf14e01, fireGen, -3)],
  ['water.wav', () => makeLoop(0x3a7e02, waterGen, -3)],
  ['wind.wav', () => makeLoop(0x3140d3, windGen, -3)],
  ['room-tone.wav', () => makeLoop(0x400e04, roomGen, -30)],
];
for (const [name, make] of files) {
  const buf = make();
  writeWav(join(outDir, name), buf);
  console.log(`${name}\t${((buf.length / SR) * 1000).toFixed(0)} ms`);
}
