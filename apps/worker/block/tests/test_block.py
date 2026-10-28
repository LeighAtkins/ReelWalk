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
from solve import Budget, SolveError, solve  # noqa: E402
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


class Clock:
    """A clock the test moves: the solve's budget reads it instead of time.monotonic."""

    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def fixture_images():
    names = sorted(n for n in os.listdir(FIXTURE) if n.endswith(".jpg"))
    return [cv2.imread(os.path.join(FIXTURE, n)) for n in names]


class BudgetPace(unittest.TestCase):
    """Budget.step alone, with timings Sol's review gave."""

    def run_steps(self, durations, seconds=420):
        clock = Clock()
        b = Budget(seconds, clock)
        b.begin(len(durations))
        for k, d in enumerate(durations):
            clock.t += d
            b.step(len(durations) - k - 1)
        return clock.t

    def test_a_slow_start_then_fast_is_not_refused(self):
        # 5 frames at 30 s (nothing cached yet), then 65 at 3 s: finishes at 345 s, inside 420.
        self.assertAlmostEqual(self.run_steps([30.0] * 5 + [3.0] * 65), 345.0)

    def test_a_steadily_slow_reading_is_refused_on_sustained_evidence(self):
        # 70 frames at 10 s would finish at 700 s; refused once a quarter (18) are done, at 180 s, long before 420.
        clock = Clock()
        b = Budget(420, clock)
        b.begin(70)
        with self.assertRaises(SolveError) as e:
            for k in range(70):
                clock.t += 10.0
                b.step(70 - k - 1)
        self.assertEqual(e.exception.code, "too-slow")
        self.assertAlmostEqual(clock.t, 180.0)

    def test_the_budget_is_absolute_even_before_there_is_evidence(self):
        clock = Clock()
        b = Budget(420, clock)
        b.begin(70)
        clock.t = 500.0  # gone during the first frame, before any projection is allowed
        with self.assertRaises(SolveError):
            b.step(69)


class BudgetInTheSolve(unittest.TestCase):
    """The real solve on the real fixture (5 registrations after the init pair), its budget on a clock the test moves."""

    def solve_with(self, on_log=None, on_progress=None, seconds=420):
        clock = Clock()
        log = (lambda line: on_log(clock, line)) if on_log else quiet
        progress = (lambda done, total: on_progress(clock, done, total)) if on_progress else None
        try:
            solve(fixture_images(), fps=1.5, log=log, budget=Budget(seconds, clock), progress=progress)
        except SolveError as e:
            return e, clock.t
        return None, clock.t

    def test_expiry_during_the_warmup(self):
        # the time runs out right after the init: the first registration must not start
        seen = []
        def on_log(clock, line):
            if line.startswith("init"):
                clock.t = 500.0
        def on_progress(clock, done, total):
            seen.append(done)
        e, _ = self.solve_with(on_log, on_progress)
        self.assertEqual(e.code, "too-slow")
        self.assertEqual(seen, [])

    def test_expiry_in_the_last_iteration(self):
        def on_progress(clock, done, total):
            if done == total - 1:
                clock.t = 500.0
        e, _ = self.solve_with(on_progress=on_progress)
        self.assertEqual(e.code, "too-slow")

    def test_expiry_after_the_last_registration_stops_before_post_processing(self):
        def on_progress(clock, done, total):
            if done == total:
                clock.t = 500.0
        e, _ = self.solve_with(on_progress=on_progress)
        self.assertEqual(e.code, "too-slow")

    def test_the_projection_refuses_before_the_time_is_gone(self):
        # 100 s a frame: after 3 of 5 (the evidence threshold) it is 300 s and 2 more would end at 500 > 420
        def on_progress(clock, done, total):
            clock.t += 100.0
        e, t = self.solve_with(on_progress=on_progress)
        self.assertEqual(e.code, "too-slow")
        self.assertIn("420 seconds", e.message)
        self.assertAlmostEqual(t, 300.0)  # refused on the projection, with time still left

    def test_a_reading_inside_its_budget_succeeds(self):
        def on_progress(clock, done, total):
            clock.t += 10.0
        e, t = self.solve_with(on_progress=on_progress)
        self.assertIsNone(e)
        self.assertAlmostEqual(t, 50.0)


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
