# Walk the block, step 1 (ADR 0093): read a drone clip in 3D. Called by the worker (src/walk-block.ts):
#
#   python run.py <video> <out-dir> [--seconds 24] [--fps 3] [--width 1920] [--altitude-m 92]
#
# Writes <out-dir>/solve.json (cameras in metres, ground, scale, sun, a sample of ground points) and <out-dir>/still.jpg
# (the first frame, for the pin screen). Prints progress lines; on a clip it refuses, writes solve.json with
# {"ok": false, "code", "message"} and exits 0, so the worker can show the person the reason. Any other exit is a bug.
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from solve import SolveError, solve  # noqa: E402
from measure import DEFAULT_SUN, world  # noqa: E402

VERSION = 1
MAX_POINTS = 4000


def log(line):
    print(line, flush=True)


def probe(ffmpeg, video):
    # ffmpeg -i prints the stream line to stderr; enough to get the size and duration without ffprobe.
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", video], capture_output=True, text=True).stderr
    import re
    size = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", out)
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
    w, h = (int(size.group(1)), int(size.group(2))) if size else (0, 0)
    seconds = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else 0.0
    return w, h, seconds


def frames(ffmpeg, video, out_dir, fps, width, seconds):
    d = os.path.join(out_dir, "frames")
    os.makedirs(d, exist_ok=True)
    subprocess.run([ffmpeg, "-v", "error", "-y", "-t", str(seconds), "-i", video, "-vf", "fps=%g,scale=%d:-2" % (fps, width),
                    "-q:v", "2", os.path.join(d, "f%03d.jpg")], check=True)
    names = sorted(n for n in os.listdir(d) if n.endswith(".jpg"))
    return [cv2.imread(os.path.join(d, n)) for n in names]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--seconds", type=float, default=24.0)
    ap.add_argument("--fps", type=float, default=3.0)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--altitude-m", type=float, default=None)
    ap.add_argument("--frames-dir", default=None, help="solve these frames (sorted, at --fps) instead of decoding the video")
    a = ap.parse_args(argv)
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    os.makedirs(a.out, exist_ok=True)
    started = time.time()
    cv2.setNumThreads(max(1, os.cpu_count() or 1))
    src_w, src_h, duration = probe(ffmpeg, a.video)
    if src_w <= 0:
        raise SystemExit("could not read the video")
    width = min(a.width, src_w if src_w >= src_h else a.width)
    if a.frames_dir:
        names = sorted(n for n in os.listdir(a.frames_dir) if n.endswith(".jpg"))
        images = [cv2.imread(os.path.join(a.frames_dir, n)) for n in names]
    else:
        images = frames(ffmpeg, a.video, a.out, a.fps, width, min(a.seconds, duration or a.seconds))
    log("frames %d at %dx%d (%.1f s)" % (len(images), images[0].shape[1], images[0].shape[0], time.time() - started))
    result = {"version": VERSION, "ok": True}
    try:
        if src_h > src_w:
            raise SolveError("portrait", "This clip is portrait. Walk the block reads landscape drone footage.")
        sol = solve(images, a.fps, log=log)
        wd = world(sol, a.altitude_m)
    except SolveError as e:
        json.dump({"version": VERSION, "ok": False, "code": e.code, "message": e.message}, open(os.path.join(a.out, "solve.json"), "w"))
        log("refused: %s" % e.code)
        return 0
    K = sol["K"]
    cams = wd["cameras"]
    keys = sorted(cams)
    sun = {**DEFAULT_SUN, "basis": "assumed"}
    P = wd["points"]
    rng = np.random.default_rng(7)
    near = P[np.hypot(P[:, 0], P[:, 2]) < 1500]
    sample = near[rng.choice(len(near), min(MAX_POINTS, len(near)), replace=False)] if len(near) else near
    result.update({
        "source": {"width": src_w, "height": src_h, "durationMs": int(round(duration * 1000)), "solvedSeconds": round(len(images) / a.fps, 3)},
        "intrinsics": {"width": sol["width"], "height": sol["height"], "f": round(float(K[0, 0]), 3), "cx": float(K[0, 2]), "cy": float(K[1, 2])},
        "cameras": [{"t": round(j / a.fps, 4), "R": [round(float(v), 7) for v in cams[j][0].ravel()],
                     "C": [round(float(v), 4) for v in cams[j][1]]} for j in keys],
        "points": [[round(float(v), 2) for v in p] for p in sample],
        "scale": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in wd["scale"].items()},
        "ground": wd["ground"],
        "sun": sun,
        "stats": {**sol["stats"], "seconds": round(time.time() - started, 1)},
    })
    # The pin screen's still: the first frame at up to 1920 px high (a 9:16 crop of it fills a phone).
    still_h = min(1920, src_h)
    subprocess.run([ffmpeg, "-v", "error", "-y", "-i", a.video, "-frames:v", "1", "-vf", "scale=-2:%d" % still_h, "-q:v", "3",
                    os.path.join(a.out, "still.jpg")], check=True)
    result["still"] = {"t": 0, "width": int(round(src_w * still_h / src_h / 2) * 2), "height": still_h}
    json.dump(result, open(os.path.join(a.out, "solve.json"), "w"), separators=(",", ":"))
    log("done in %.1f s" % (time.time() - started))
    return 0


if __name__ == "__main__":
    sys.exit(main())
