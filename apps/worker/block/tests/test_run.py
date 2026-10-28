# Tests for run.py (ADR 0093, review of PR #259): what is refused before anything is decoded, and that each sampled
# frame carries the moment it was filmed. The ffmpeg tests need ffmpeg (FFMPEG_PATH or on PATH); the worker image has it.
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import run  # noqa: E402
from solve import SolveError  # noqa: E402

FFMPEG = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
BITS = 8


def numbered_video(path, count, fps=30, size=(320, 180)):
    """A clip whose every frame shows its own index as 8 black/white bars (robust to compression)."""
    w, h = size
    proc = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "%dx%d" % (w, h), "-r", str(fps),
                             "-i", "-", "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)
    for k in range(count):
        frame = np.zeros((h, w), np.uint8)
        for b in range(BITS):
            if (k >> b) & 1:
                frame[:, b * w // BITS:(b + 1) * w // BITS] = 255
        proc.stdin.write(frame.tobytes())
    proc.stdin.close()
    proc.wait()


def read_code(out):
    with open(os.path.join(out, "solve.json")) as f:
        return json.load(f)["code"]


def index_of(image):
    grey = image.mean(axis=2) if image.ndim == 3 else image
    w = grey.shape[1]
    return sum(1 << b for b in range(BITS) if grey[:, b * w // BITS + 4:(b + 1) * w // BITS - 4].mean() > 127)


class Plan(unittest.TestCase):
    def test_refuses_before_decoding(self):
        cases = [((1080, 10000, 20, 30), "portrait"), ((0, 0, 20, 30), "unreadable"), ((15360, 8640, 20, 30), "too-large"),
                 ((5760, 1080, 20, 30), "too-wide"), ((3840, 2160, 3.0, 30), "too-short"), ((3840, 2160, 20, 0), "frame-rate")]
        for args, code in cases:
            with self.assertRaises(SolveError) as e:
                run.plan(*args)
            self.assertEqual(e.exception.code, code, args)

    def test_samples_whole_frames_inside_the_memory_budget(self):
        p = run.plan(3840, 2160, 25.3, 29.97)
        self.assertEqual(p["step"], 10)
        self.assertAlmostEqual(p["fps"], 2.997, places=3)
        self.assertEqual((p["width"], p["height"]), (1280, 720))  # the solve reads 1280-wide frames (ADR 0093, speed)
        self.assertLessEqual(p["count"] * p["width"] * p["height"] * 3, run.DECODE_BUDGET_BYTES)
        self.assertEqual(run.plan(3840, 2160, 25.3, 23.976)["step"], 8)


class Cgroups(unittest.TestCase):
    """The process's own cgroup, found the way Go's runtime finds it (review round 2)."""

    def files(self, table):
        return lambda path: table.get(path)

    def test_v2_with_the_quota_on_a_parent_of_the_process_cgroup(self):
        proc = "0::/ecs/task-1/container-a\n"
        mounts = "30 23 0:26 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n"
        read = self.files({"/sys/fs/cgroup/ecs/task-1/container-a/cpu.max": "max 100000\n",
                           "/sys/fs/cgroup/ecs/task-1/cpu.max": "200000 100000\n",
                           "/sys/fs/cgroup/cpu.max": "max 100000\n"})
        self.assertEqual(run.cgroup_cpu_max(proc, mounts, read), "200000 100000")
        self.assertEqual(run.cpu_budget(8, run.cgroup_cpu_max(proc, mounts, read)), 2)

    def test_a_combined_v1_cpu_cpuacct_mount(self):
        proc = "12:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n"
        mounts = ("31 23 0:27 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n"
                  "32 23 0:28 / /sys/fs/cgroup/cpu,cpuacct rw - cgroup cgroup rw,cpu,cpuacct\n")
        read = self.files({"/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_quota_us": "200000\n",
                           "/sys/fs/cgroup/cpu,cpuacct/docker/abc/cpu.cfs_period_us": "100000\n"})
        self.assertEqual(run.cgroup_cpu_max(proc, mounts, read), "200000 100000")

    def test_a_container_whose_mount_root_is_its_own_cgroup(self):
        # inside a container the hierarchy is mounted from the container's cgroup: root /docker/abc, process in /docker/abc
        proc = "0::/docker/abc\n"
        mounts = "40 30 0:30 /docker/abc /sys/fs/cgroup ro - cgroup2 cgroup2 rw\n"
        read = self.files({"/sys/fs/cgroup/cpu.max": "150000 100000\n"})
        self.assertEqual(run.cgroup_cpu_max(proc, mounts, read), "150000 100000")

    def test_no_quota(self):
        proc = "0::/user.slice\n"
        mounts = "30 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n"
        read = self.files({"/sys/fs/cgroup/user.slice/cpu.max": "max 100000\n", "/sys/fs/cgroup/cpu.max": None})
        self.assertIsNone(run.cgroup_cpu_max(proc, mounts, read))
        self.assertIsNone(run.cgroup_cpu_max("", "", read))


class Probe(unittest.TestCase):
    def test_a_stalled_probe_is_a_too_slow_refusal_within_the_budget(self):
        calls = []
        real = run.subprocess.run

        def stalled(cmd, **kw):
            calls.append(kw.get("timeout"))
            raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
        out = tempfile.mkdtemp()
        os.environ["BLOCK_SOLVE_BUDGET_S"] = "30"
        run.subprocess.run = stalled
        try:
            self.assertEqual(run.main(["clip.mp4", out]), 0)
        finally:
            run.subprocess.run = real
            del os.environ["BLOCK_SOLVE_BUDGET_S"]
        self.assertEqual(read_code(out), "too-slow")
        self.assertEqual(len(calls), 1)
        self.assertLessEqual(calls[0], 30)
        shutil.rmtree(out, ignore_errors=True)


class Threads(unittest.TestCase):
    def test_follows_the_cgroup_quota_not_the_cpus_visible(self):
        self.assertEqual(run.cpu_budget(8, "200000 100000"), 2)   # a 2-vCPU task that can see 8 CPUs
        self.assertEqual(run.cpu_budget(8, "150000 100000"), 2)   # 1.5 CPUs: two threads
        self.assertEqual(run.cpu_budget(8, "max 100000"), 8)      # no quota
        self.assertEqual(run.cpu_budget(4, None), 4)
        self.assertEqual(run.cpu_budget(8, "200000 100000", "3"), 3)  # BLOCK_SOLVE_THREADS


@unittest.skipUnless(FFMPEG, "needs ffmpeg")
class Frames(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_each_frame_carries_the_moment_it_was_filmed(self):
        # 30 fps, every 10th frame: frames 0, 10, 20 ... at 0, 1/3, 2/3 s. (The fps filter this replaced picked the last
        # frame of each rounded bucket, ~0.13 s late, while the camera was labelled with the bucket's start.)
        video = os.path.join(self.dir, "n.mp4")
        numbered_video(video, 160)
        w, h, seconds, fps = run.probe(FFMPEG, video)
        self.assertEqual((w, h), (320, 180))
        self.assertAlmostEqual(fps, 30, places=2)
        p = run.plan(w, h, seconds, fps)
        images, times = run.frames(FFMPEG, video, self.dir, p)
        self.assertGreaterEqual(len(images), 15)
        for k, (image, t) in enumerate(zip(images, times)):
            n = index_of(image)
            self.assertEqual(n, k * p["step"], "sample %d shows frame %d" % (k, n))
            self.assertAlmostEqual(t, n / 30.0, places=3)

    def test_a_portrait_clip_is_refused_without_decoding_its_frames(self):
        video = os.path.join(self.dir, "p.mp4")
        numbered_video(video, 180, size=(180, 320))
        out = os.path.join(self.dir, "out")
        self.assertEqual(run.main([video, out]), 0)
        self.assertEqual(read_code(out), "portrait")
        self.assertFalse(os.path.exists(os.path.join(out, "frames")))

    def test_a_clip_past_the_time_budget_is_refused_as_too_slow(self):
        video = os.path.join(self.dir, "b.mp4")
        numbered_video(video, 180)
        out = os.path.join(self.dir, "out")
        os.environ["BLOCK_SOLVE_BUDGET_S"] = "0"
        try:
            self.assertEqual(run.main([video, out]), 0)
        finally:
            del os.environ["BLOCK_SOLVE_BUDGET_S"]
        self.assertEqual(read_code(out), "too-slow")

    def test_a_short_clip_is_refused(self):
        video = os.path.join(self.dir, "s.mp4")
        numbered_video(video, 90)
        out = os.path.join(self.dir, "out")
        self.assertEqual(run.main([video, out]), 0)
        self.assertEqual(read_code(out), "too-short")


if __name__ == "__main__":
    unittest.main()
