// A stand-in for ffmpeg in renderReveal's tests (tests/walk-block.test.ts): run as `node fake-ffmpeg.mjs <ffmpeg args>`.
// Decoding ("-f rawvideo ... -" as the output): writes FAKE_DECODE_FRAMES black frames of the size in "scale=W:H".
// Encoding ("-i -"): FAKE_ENCODE=ok reads stdin to the end and writes a stub file; FAKE_ENCODE=die exits 1 after the
// first frame's worth of bytes. FAKE_DECODE_HANG=1: the decoder writes nothing and never exits.
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { setInterval } from "node:timers";

const args = process.argv.slice(2);
if (args.includes("-i") && args[args.indexOf("-i") + 1] === "-") {
  const size = args[args.indexOf("-s") + 1].split("x").map(Number);
  const frame = size[0] * size[1] * 3;
  let got = 0;
  process.stdin.on("data", (chunk) => {
    got += chunk.length;
    if (process.env.FAKE_ENCODE === "die" && got >= frame) {
      process.stderr.write("fake encoder: out of disk\n");
      process.exit(1);
    }
  });
  process.stdin.on("end", () => {
    writeFileSync(args[args.length - 1], `frames ${got / frame}`);
    process.exit(0);
  });
} else if (process.env.FAKE_DECODE_HANG === "1") {
  // A decoder stuck on a bad file: writes nothing and never exits on its own.
  setInterval(() => undefined, 1000);
} else {
  const [w, h] = /scale=(\d+):(\d+)/.exec(args[args.indexOf("-vf") + 1]).slice(1).map(Number);
  const frames = Number(process.env.FAKE_DECODE_FRAMES ?? 1000);
  const frame = Buffer.alloc(w * h * 3, 40);
  let k = 0;
  const next = () => {
    while (k < frames) {
      k++;
      if (!process.stdout.write(frame)) return void process.stdout.once("drain", next);
    }
    process.exit(0);
  };
  process.stdout.on("error", () => process.exit(1));
  next();
}
