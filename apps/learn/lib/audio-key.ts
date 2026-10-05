/**
 * The file name of a line's recorded audio: two FNV-1a hashes of the exact
 * text passed to `speak`. Synchronous on purpose, so a tap can start playback
 * without an await (iOS only plays audio started inside the gesture).
 * scripts/generate-audio.ts uses the same function to name the files.
 */
export function audioKey(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
