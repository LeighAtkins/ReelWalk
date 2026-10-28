# Tests for the drone solve (ADR 0093). Run from apps/worker/block:  python -m unittest discover -s tests
# The fixture is the first 4 s of the real clip the method was proven on (Pexels 14194694, Danilo Riba; see
# fixtures/drone-14194694/SOURCE.md), 7 frames at 1.5 fps, 960 px wide.
import os
import sys
import time
import unittest

import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from solve import SolveError, overruns, solve  # noqa: E402
from measure import ASSUMED_ALTITUDE_M, world  # noqa: E402

FIXTURE = os.path.join(HERE, "fixtures", "drone-14194694")


def quiet(_line):
    pass


class RealClip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        names = sorted(n for n in os.listdir(FIXTURE) if n.endswith(".jpg"))
        cls.images = [cv2.imread(os.path.join(FIXTURE, n)) for n in names]
        cls.sol = solve(cls.images, fps=1.5, count=4000, log=quiet)
        cls.w = world(cls.sol)

    def test_every_frame_is_solved_sharply(self):
        st = self.sol["stats"]
        self.assertEqual(st["registered"], len(self.images))
        self.assertLess(st["medianReprojectionPx"], 0.6)

    def test_depth_is_the_right_way_round(self):
        # The bottom of a forward-down view is nearer than its middle (the full clip gives 0.32; COLMAP gave > 1).
        self.assertIsNotNone(self.sol["stats"]["depthOrder"])
        self.assertLess(self.sol["stats"]["depthOrder"], 0.6)

    def test_ground_is_level_and_found(self):
        g = self.w["ground"]
        self.assertLess(g["tiltFromGravityDeg"], 5.0)
        self.assertGreater(g["inlierShare"], 0.2)

    def test_world_is_metric_at_the_assumed_height_and_flies_forward(self):
        cams = self.w["cameras"]
        self.assertAlmostEqual(cams[0][1][1], ASSUMED_ALTITUDE_M, places=6)
        self.assertEqual(self.w["scale"]["basis"], "assumed")
        # The full-clip solve (prototype and this port agree to 0.4%): 4 s in, the drone is 31.8 m forward, 1.2 m left
        # and 0.5 m lower when the first camera is 92 m up. At the assumed 60 m that is 20.7 m forward.
        C = cams[max(cams)][1] * (92.0 / ASSUMED_ALTITUDE_M)
        self.assertAlmostEqual(C[2], -31.8, delta=2.5)
        self.assertAlmostEqual(C[0], -1.2, delta=1.5)
        self.assertAlmostEqual(C[1], 91.5, delta=1.5)

    def test_cameras_look_down_and_forward(self):
        R = self.w["cameras"][0][0]
        forward = R[:, 2]
        # The full clip's horizon sits ~146 px above the centre of a 1080-high frame at f 1280: 6.5 deg down.
        self.assertLess(forward[1], -0.05)
        self.assertGreater(forward[1], -0.25)
        self.assertLess(forward[2], 0)     # towards -z
        self.assertAlmostEqual(R[:, 0][1], 0.0, delta=0.05)  # level horizon

    def test_stated_altitude_rescales(self):
        w = world(self.sol, altitude_m=92.0)
        self.assertEqual(w["scale"]["basis"], "stated")
        self.assertAlmostEqual(w["cameras"][0][1][1], 92.0, places=6)


class Budget(unittest.TestCase):
    def test_projects_an_overrun_from_the_frames_done(self):
        # 10 frames in 20 s, 60 to go: 120 s more. Finishing at t = 150 misses a deadline at 140, makes one at 160.
        self.assertTrue(overruns(30.0, 10.0, 10, 60, 140.0))
        self.assertFalse(overruns(30.0, 10.0, 10, 60, 160.0))
        self.assertFalse(overruns(30.0, 10.0, 4, 600, 31.0))  # too few frames to judge yet

    def test_stops_early_with_a_clear_reason(self):
        names = sorted(n for n in os.listdir(FIXTURE) if n.endswith(".jpg"))
        images = [cv2.imread(os.path.join(FIXTURE, n)) for n in names]
        with self.assertRaises(SolveError) as e:
            solve(images, fps=1.5, log=quiet, deadline=(time.monotonic(), 420))
        self.assertEqual(e.exception.code, "too-slow")
        self.assertIn("420 seconds", e.exception.message)


class Refusals(unittest.TestCase):
    def test_too_short(self):
        frame = np.zeros((90, 160, 3), np.uint8)
        with self.assertRaises(SolveError) as e:
            solve([frame] * 3, fps=3, log=quiet)
        self.assertEqual(e.exception.code, "too-short")

    def test_no_parallax(self):
        # A drone turning on the spot (pure rotation, 1.5 deg a frame): every frame is a homography of one texture.
        rng = np.random.default_rng(3)
        tex = cv2.GaussianBlur((rng.random((1200, 1600)) * 255).astype(np.uint8), (0, 0), 2)
        Kt = np.array([[640.0, 0, 800], [0, 640, 600], [0, 0, 1]])
        Kf = np.array([[640.0, 0, 480], [0, 640, 270], [0, 0, 1]])
        frames = []
        for k in range(13):
            a = np.radians(1.5 * k)
            Ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
            frames.append(cv2.cvtColor(cv2.warpPerspective(tex, Kf @ Ry @ np.linalg.inv(Kt), (960, 540)), cv2.COLOR_GRAY2BGR))
        with self.assertRaises(SolveError) as e:
            solve(frames, fps=3, count=1500, log=quiet)
        self.assertEqual(e.exception.code, "no-parallax")


if __name__ == "__main__":
    unittest.main()
