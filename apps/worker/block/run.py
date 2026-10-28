# Walk the block, step 1 (ADR 0093): read a drone clip in 3D. Called by the worker (src/walk-block.ts):
#
#   python run.py <video> <out-dir> [--seconds 24] [--fps 3] [--width 1280] [--altitude-m 92]
#
# BLOCK_SOLVE_BUDGET_S (default 420): seconds the whole reading may take, from the start of this script. The worker's
# step deadline is 600 s; past the budget (or once the solve can see it will be) the clip is refused as "too-slow".
#
# Writes <out-dir>/solve.json (cameras in metres, ground, scale, sun, a sample of ground points) and <out-dir>/still.jpg
# (the first frame, for the pin screen). Prints progress lines; on a clip it refuses, writes solve.json with
# {"ok": false, "code", "message"} and exits 0, so the worker can show the person the reason. Any other exit is a bug.
import argparse
import json
import math
import os
import re
import subprocess
import sys
import time

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from solve import Budget, SolveError, solve, too_slow  # noqa: E402
from measure import DEFAULT_SUN, world  # noqa: E402

VERSION = 1
MAX_POINTS = 4000
# What the solve reads, decided from the probe before a single frame is decoded (review of PR #259: a 1080 x 10000 clip
# was decoded whole, ~7 GB, before being refused as portrait).
MIN_SECONDS = 5.0          # footage the solve starts on
MIN_REVEAL_SECONDS = 4.5   # solved flight the reveal needs (MIN_REVEAL_SECONDS in core)
MAX_SIDE = (8192, 4320)    # 8K
MAX_ASPECT = 2.4           # wider is a panorama or a 360 strip, not a drone pass
FPS_RANGE = (10.0, 121.0)
DECODE_BUDGET_BYTES = 900 * 1024 * 1024  # every sampled frame is held in memory at once


def write_json(path, value):
    with open(path, "w") as f:
        json.dump(value, f, separators=(",", ":"))


def log(line):
    print(line, flush=True)


def probe(ffmpeg, video, timeout=None):
    # ffmpeg -i prints the stream line to stderr; enough to get the size, frame rate and duration without ffprobe.
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", video], capture_output=True, text=True, timeout=timeout).stderr
    stream = re.search(r"Stream[^\n]*Video:[^\n]*", out)
    line = stream.group(0) if stream else ""
    size = re.search(r", (\d{2,6})x(\d{2,6})", line)
    rate = re.search(r", ([\d.]+) fps", line) or re.search(r", ([\d.]+) tbr", line)
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
    w, h = (int(size.group(1)), int(size.group(2))) if size else (0, 0)
    seconds = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else 0.0
    return w, h, seconds, float(rate.group(1)) if rate else 0.0


def plan(src_w, src_h, seconds, src_fps, want_fps=3.0, max_seconds=24.0, max_width=1280):
    """What to decode, or a SolveError for a clip the solve will not read. Decided from the probe alone."""
    if src_w <= 0 or src_h <= 0:
        raise SolveError("unreadable", "This file could not be read as a video.")
    if src_h > src_w:
        raise SolveError("portrait", "This clip is portrait. Walk the block reads landscape drone footage.")
    if src_w > MAX_SIDE[0] or src_h > MAX_SIDE[1]:
        raise SolveError("too-large", "This clip is larger than 8K. Export it at 4K or smaller.")
    if src_w / src_h > MAX_ASPECT:
        raise SolveError("too-wide", "This clip is wider than a drone camera films (a panorama or a 360 strip).")
    if not (FPS_RANGE[0] <= src_fps <= FPS_RANGE[1]):
        raise SolveError("frame-rate", "This clip's frame rate could not be read. Export it again at 24-60 fps.")
    if seconds < MIN_SECONDS:
        raise SolveError("too-short", "The clip is too short to read in 3D. Use at least %g seconds of drone footage." % MIN_SECONDS)
    step = max(1, int(round(src_fps / want_fps)))
    fps = src_fps / step
    use = min(seconds, max_seconds)
    count = int(use * fps) + 1
    width = min(max_width, src_w)
    height = int(round(width * src_h / src_w / 2)) * 2
    if count * width * height * 3 > DECODE_BUDGET_BYTES:
        raise SolveError("too-large", "This clip is too large to read. Export it at 4K or smaller.")
    return {"step": step, "fps": fps, "seconds": use, "width": width, "height": height, "count": count}


def cpu_budget(affinity, cpu_max=None, override=None):
    """Threads for OpenCV: an explicit override (BLOCK_SOLVE_THREADS), else the smaller of the CPUs this process may run
    on and its cgroup CPU quota (cgroup v2 `cpu.max`, e.g. "200000 100000" = 2 CPUs; "max ..." = no quota). Affinity alone
    over-counts in a container: a Fargate task may see more CPUs than its quota lets it use."""
    if override:
        return max(1, int(override))
    cpus = max(1, affinity)
    if cpu_max:
        quota, _, period = cpu_max.strip().partition(" ")
        if quota != "max" and period:
            cpus = min(cpus, max(1, int(math.ceil(int(quota) / int(period)))))
    return cpus


def cgroup_cpu_max(proc_cgroup, mountinfo, read):
    """This process's CPU quota as a cgroup v2 `cpu.max` string ("quota period"), or None when it has none.

    Resolved as Go's runtime does: /proc/self/cgroup names the process's cgroup (v2 "0::/path", or a v1 line whose
    controllers include "cpu", e.g. "4:cpu,cpuacct:/path"); /proc/self/mountinfo says where that hierarchy is mounted
    (fstype cgroup2, or cgroup with "cpu" among its super options) and from which root. The cgroup's directory under the
    mount, and every parent up to the mount point, is read; the tightest quota wins (a limit set on an ancestor applies).
    `read(path)` returns a file's text or None.
    """
    v2_path, v1_path = None, None
    for line in proc_cgroup.splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3:
            continue
        if parts[0] == "0" and parts[1] == "":
            v2_path = parts[2]
        elif "cpu" in parts[1].split(","):
            v1_path = parts[2]
    best = None
    for line in mountinfo.splitlines():
        fields = line.split()
        if "-" not in fields:
            continue
        dash = fields.index("-")
        fstype, options = fields[dash + 1], fields[dash + 3] if len(fields) > dash + 3 else ""
        root_dir, mount_point = fields[3], fields[4]
        if fstype == "cgroup2" and v2_path is not None:
            path, v1 = v2_path, False
        elif fstype == "cgroup" and v1_path is not None and "cpu" in options.split(","):
            path, v1 = v1_path, True
        else:
            continue
        rel = path[len(root_dir):] if root_dir != "/" and path.startswith(root_dir) else (path if root_dir == "/" else None)
        if rel is None:
            continue
        here = os.path.normpath(mount_point + "/" + rel.lstrip("/")).replace("\\", "/")
        while True:
            if v1:
                q, per = read(here + "/cpu.cfs_quota_us"), read(here + "/cpu.cfs_period_us")
                text = None if q is None or per is None or q.strip() == "-1" else q.strip() + " " + per.strip()
            else:
                text = read(here + "/cpu.max")
            if text and not text.strip().startswith("max"):
                quota, _, period = text.strip().partition(" ")
                cpus = int(quota) / int(period)
                if best is None or cpus < best[0]:
                    best = (cpus, text.strip())
            if here.rstrip("/") == mount_point.rstrip("/") or len(here) <= len(mount_point):
                break
            here = os.path.dirname(here).replace("\\", "/")
    return best[1] if best else None


def read_cpu_max():
    def read(path):
        try:
            with open(path) as f:
                return f.read()
        except OSError:
            return None
    proc_cgroup, mountinfo = read("/proc/self/cgroup"), read("/proc/self/mountinfo")
    if not proc_cgroup or not mountinfo:
        return None
    return cgroup_cpu_max(proc_cgroup, mountinfo, read)


def frames(ffmpeg, video, out_dir, p, timeout=None):
    """Every `step`-th source frame (no resampling: each is a real frame) with its own timestamp from the source, so a
    camera is labelled with the moment its frame was filmed. Times run from the first frame (0)."""
    d = os.path.join(out_dir, "frames")
    os.makedirs(d, exist_ok=True)
    # Quoted, so the comma inside mod() is not a filter separator.
    vf = "select='not(mod(n,%d))',showinfo,scale=%d:%d" % (p["step"], p["width"], p["height"])
    run = subprocess.run([ffmpeg, "-hide_banner", "-v", "info", "-y", "-t", "%.3f" % p["seconds"], "-i", video, "-vf", vf,
                          "-fps_mode", "passthrough", "-frames:v", str(p["count"]), "-q:v", "2", os.path.join(d, "f%03d.jpg")],
                         capture_output=True, text=True, timeout=timeout)
    if run.returncode != 0:
        raise RuntimeError("ffmpeg could not decode the clip: %s" % run.stderr[-400:])
    pts = [float(m) for m in re.findall(r"Parsed_showinfo[^\n]*?pts_time:\s*([-\d.]+)", run.stderr)]
    names = sorted(n for n in os.listdir(d) if n.endswith(".jpg"))
    if not names or len(pts) < len(names):
        raise RuntimeError("ffmpeg reported %d frame times for %d frames" % (len(pts), len(names)))
    times = [round(t - pts[0], 4) for t in pts[: len(names)]]
    return [cv2.imread(os.path.join(d, n)) for n in names], times


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--seconds", type=float, default=24.0)
    ap.add_argument("--fps", type=float, default=3.0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--altitude-m", type=float, default=None)
    ap.add_argument("--frames-dir", default=None, help="solve these frames (sorted, at --fps) instead of decoding the video")
    a = ap.parse_args(argv)
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    os.makedirs(a.out, exist_ok=True)
    started = time.time()
    # Threads OpenCV may use: the container's CPU quota, not the host's count (BLOCK_SOLVE_THREADS overrides).
    affinity = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    cv2.setNumThreads(cpu_budget(affinity, read_cpu_max(), os.environ.get("BLOCK_SOLVE_THREADS")))
    budget = Budget(float(os.environ.get("BLOCK_SOLVE_BUDGET_S", "420")))
    result = {"version": VERSION, "ok": True}
    try:
        # Inside the budget like everything else: a probe that stalls is a "too-slow" refusal, not a crashed command.
        try:
            src_w, src_h, duration, src_fps = probe(ffmpeg, a.video, timeout=max(0.1, min(60.0, budget.remaining())))
        except subprocess.TimeoutExpired:
            raise too_slow(budget.seconds)
        p = plan(src_w, src_h, duration, src_fps, a.fps, a.seconds, a.width)
        if a.frames_dir:
            names = sorted(n for n in os.listdir(a.frames_dir) if n.endswith(".jpg"))
            images = [cv2.imread(os.path.join(a.frames_dir, n)) for n in names]
            times = [round(k / p["fps"], 4) for k in range(len(images))]
        else:
            budget.check()
            try:
                images, times = frames(ffmpeg, a.video, a.out, p, timeout=max(1.0, budget.remaining()))
            except subprocess.TimeoutExpired:
                raise too_slow(budget.seconds)
        log("frames %d at %dx%d, every %d of %.3f fps (%.1f s)" % (len(images), images[0].shape[1], images[0].shape[0], p["step"], src_fps, time.time() - started))
        budget.check()
        sol = solve(images, p["fps"], log=log, budget=budget)
        last = max(sol["cameras"])
        if times[last] - times[0] < MIN_REVEAL_SECONDS:
            raise SolveError("too-short", "Only the first %.1f seconds of the flight could be followed; the reveal needs %g." % (times[last], MIN_REVEAL_SECONDS))
        budget.check()
        wd = world(sol, a.altitude_m)
        budget.check()
        # The pin screen's still: the first frame at up to 1920 px high (a 9:16 crop of it fills a phone).
        still_h = min(1920, src_h)
        try:
            subprocess.run([ffmpeg, "-v", "error", "-y", "-i", a.video, "-frames:v", "1", "-vf", "scale=-2:%d" % still_h, "-q:v", "3",
                            os.path.join(a.out, "still.jpg")], check=True, timeout=max(1.0, budget.remaining()))
        except subprocess.TimeoutExpired:
            raise too_slow(budget.seconds)
    except SolveError as e:
        write_json(os.path.join(a.out, "solve.json"), {"version": VERSION, "ok": False, "code": e.code, "message": e.message})
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
        "source": {"width": src_w, "height": src_h, "durationMs": int(round(duration * 1000)), "solvedSeconds": round(times[-1], 3), "fps": round(src_fps, 4)},
        "intrinsics": {"width": sol["width"], "height": sol["height"], "f": round(float(K[0, 0]), 3), "cx": float(K[0, 2]), "cy": float(K[1, 2])},
        "cameras": [{"t": times[j], "R": [round(float(v), 7) for v in cams[j][0].ravel()],
                     "C": [round(float(v), 4) for v in cams[j][1]]} for j in keys],
        "points": [[round(float(v), 2) for v in p] for p in sample],
        "scale": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in wd["scale"].items()},
        "ground": wd["ground"],
        "sun": sun,
        "stats": {**sol["stats"], "seconds": round(time.time() - started, 1)},
    })
    result["still"] = {"t": 0, "width": int(round(src_w * still_h / src_h / 2) * 2), "height": still_h}
    write_json(os.path.join(a.out, "solve.json"), result)
    log("done in %.1f s" % (time.time() - started))
    return 0


if __name__ == "__main__":
    sys.exit(main())
