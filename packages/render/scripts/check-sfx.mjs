// check.mjs — inspect the WAVs written by make-sfx.mjs.  Usage: node check.mjs <dir>
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'out');
const loops = new Set(['fire.wav', 'water.wav', 'wind.wav', 'room-tone.wav']);
let ok = true;
for (const name of readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
  const b = readFileSync(join(dir, name));
  const sr = b.readUInt32LE(24), ch = b.readUInt16LE(22), bits = b.readUInt16LE(34);
  const dataLen = b.readUInt32LE(40), n = dataLen / 2;
  let peak = 0, peakIdx = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const s = b.readInt16LE(44 + i * 2) / 32768;
    sum += s;
    const v = Math.abs(s);
    if (v > peak) { peak = v; peakIdx = i; }
  }
  const dc = sum / n;
  const lenMs = (n / sr) * 1000;
  const peakDb = 20 * Math.log10(peak);
  const peakMs = (peakIdx / sr) * 1000;
  const first = b.readInt16LE(44) / 32768, last = b.readInt16LE(44 + (n - 1) * 2) / 32768;
  let line = `${name.padEnd(16)} ${ch}ch ${bits}-bit ${sr} Hz  ${lenMs.toFixed(1)} ms  ${b.length} bytes  peak ${peakDb.toFixed(2)} dBFS  DC ${dc.toExponential(1)}`;
  if (name.startsWith('whoosh')) {
    const good = peakMs >= 250 && peakMs <= 350;
    line += `  peak at ${peakMs.toFixed(1)} ms ${good ? 'OK' : 'FAIL (want 250-350)'}`;
    ok &&= good;
  }
  if (name.startsWith('impact')) line += `  peak at ${peakMs.toFixed(1)} ms`;
  if (loops.has(name)) {
    const d = Math.abs(last - first);
    const good = d < 0.05;
    line += `  |last-first| ${d.toFixed(4)} ${good ? 'OK' : 'FAIL (want < 0.05)'}`;
    ok &&= good;
  }
  console.log(line);
}
console.log(ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
