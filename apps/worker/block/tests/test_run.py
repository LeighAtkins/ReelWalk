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
        self.assertEqual((p["width"], p["height"]), (1920, 1080))
        self.assertLessEqual(p["count"] * p["width"] * p["height"] * 3, run.DECODE_BUDGET_BYTES)
        self.assertEqual(run.plan(3840, 2160, 25.3, 23.976)["step"], 8)


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

    def test_a_short_clip_is_refused(self):
        video = os.path.join(self.dir, "s.mp4")
        numbered_video(video, 90)
        out = os.path.join(self.dir, "out")
        self.assertEqual(run.main([video, out]), 0)
        self.assertEqual(read_code(out), "too-short")


if __name__ == "__main__":
    unittest.main()
