# Camera solve of a drone clip (ADR 0093), ported from the au-land-maya prototype's solve_cv.py, which solved 76 of 76
# frames of a forward-down drone flight at 0.29 px median reprojection where COLMAP failed three ways (free focal collapsed
# to f ~ 140 px; fixed focal converged to a flattened, depth-reversed model).
#
# 1. SIFT on every frame, fixed intrinsics (the solver never refines focal on drone clips: focal and depth trade off).
# 2. Init: essential matrix between frame 0 and the frame ~4 s later, recoverPose, triangulate.
# 3. Every other frame: PnP-RANSAC on matches (to the three nearest registered frames) that carry a 3D point, LM refine,
#    then triangulate new points against a frame ~2 s away, keeping points with low reprojection error and > 0.6 deg parallax.
#
# Pure numpy + OpenCV (opencv-python-headless); no ffmpeg here. Units are arbitrary (the init baseline is 1);
# measure.py turns the result into a metric, gravity-aligned world.
import time

import numpy as np
import cv2


class SolveError(Exception):
    """A clip the solve refuses, with a reason code and a message for the person."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def intrinsics(width, height, focal=None):
    # A drone's standard lens is about 24 mm equivalent: 73.7 deg horizontal on a 16:9 frame, f = 2/3 of the width.
    # The prototype's two-view focal search peaked at f 1280-1500 on 1920-wide frames; 1280 is this prior.
    f = float(focal) if focal else width * 2.0 / 3.0
    return np.array([[f, 0, width / 2.0], [0, f, height / 2.0], [0, 0, 1.0]])


def too_slow(budget_s):
    return SolveError("too-slow", "Reading this clip in 3D would take longer than the %d seconds a reading may take. A "
                                  "shorter clip (10-20 seconds of flight) reads in about a minute." % int(round(budget_s)))


def overruns(now, started, done, remaining, deadline_t, warmup=5):
    """Whether the frames registered so far (`done` since `started`) say the `remaining` ones will finish after `deadline_t`."""
    return done >= warmup and now + (now - started) / done * remaining > deadline_t


def features(images, count=4000, deadline=None):
    sift = cv2.SIFT_create(count)
    kp, des, col = [], [], []
    for im in images:
        if deadline is not None and time.monotonic() > deadline[0]:
            raise too_slow(deadline[1])
        grey = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) if im.ndim == 3 else im
        k, d = sift.detectAndCompute(grey, None)
        pts = np.float64([x.pt for x in k]).reshape(-1, 2)
        kp.append(pts)
        des.append(d if d is not None else np.zeros((0, 128), np.float32))
        if im.ndim == 3 and len(pts):
            col.append(im[pts[:, 1].astype(int), pts[:, 0].astype(int)][:, ::-1])
        else:
            col.append(np.zeros((len(pts), 3), np.uint8))
    return kp, des, col


class Solver:
    def __init__(self, images, K, count=4000, matcher="flann", deadline=None):
        cv2.setRNGSeed(1)
        self.K = K
        self.N = len(images)
        self.kp, self.des, self.col = features(images, count, deadline)
        # "flann": approximate nearest neighbours (KD-trees) instead of brute force over every descriptor pair.
        self.bf = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=48)) if matcher == "flann" else cv2.BFMatcher()
        self.pose = {}                         # frame -> (R world->cam, t)
        self.obs = [dict() for _ in range(self.N)]  # frame -> {keypoint index: point id}
        self.X, self.XC = [], []
        self._matches = {}

    def match(self, i, j):
        key = (i, j)
        if key in self._matches:
            return self._matches[key]
        if len(self.des[i]) < 2 or len(self.des[j]) < 2:
            return np.zeros(0, int), np.zeros(0, int)
        m = self.bf.knnMatch(self.des[i], self.des[j], k=2)
        m = [p[0] for p in m if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
        a = np.array([x.queryIdx for x in m], int)
        b = np.array([x.trainIdx for x in m], int)
        if len(a) >= 8:
            _, inl = cv2.findFundamentalMat(self.kp[i][a], self.kp[j][b], cv2.FM_RANSAC, 1.0, 0.999)
            if inl is None:
                a, b = a[:0], b[:0]
            else:
                s = inl.ravel() > 0
                a, b = a[s], b[s]
        self._matches[key] = (a, b)
        return a, b

    def proj(self, Rw, t, P):
        x = (self.K @ (P @ Rw.T + t).T).T
        return x[:, :2] / x[:, 2:3]

    def triangulate(self, i, j):
        a, b = self.match(i, j)
        sel = [(p, q) for p, q in zip(a, b) if p not in self.obs[i] and q not in self.obs[j]]
        if not sel:
            return 0
        a, b = np.array(sel).T
        K = self.K
        (Ri, ti), (Rj, tj) = self.pose[i], self.pose[j]
        P1 = K @ np.hstack([Ri, ti[:, None]])
        P2 = K @ np.hstack([Rj, tj[:, None]])
        H = cv2.triangulatePoints(P1, P2, self.kp[i][a].T, self.kp[j][b].T)
        P = (H[:3] / H[3]).T
        e1 = np.linalg.norm(self.proj(Ri, ti, P) - self.kp[i][a], axis=1)
        e2 = np.linalg.norm(self.proj(Rj, tj, P) - self.kp[j][b], axis=1)
        z1 = (P @ Ri.T + ti)[:, 2]
        z2 = (P @ Rj.T + tj)[:, 2]
        c1 = -Ri.T @ ti
        c2 = -Rj.T @ tj
        r1 = P - c1
        r2 = P - c2
        cos = (r1 * r2).sum(1) / np.linalg.norm(r1, axis=1) / np.linalg.norm(r2, axis=1)
        ang = np.degrees(np.arccos(np.clip(cos, -1, 1)))
        ok = (e1 < 1.5) & (e2 < 1.5) & (z1 > 0) & (z2 > 0) & (ang > 0.6)
        new = 0
        for p, q, Pt, c in zip(a[ok], b[ok], P[ok], self.col[i][a[ok]]):
            pid = len(self.X)
            self.X.append(Pt)
            self.XC.append(c)
            self.obs[i][p] = pid
            self.obs[j][q] = pid
            new += 1
        return new

    def init(self, j):
        a, b = self.match(0, j)
        if len(a) < 50:
            return 0, 0.0
        E, inl = cv2.findEssentialMat(self.kp[0][a], self.kp[j][b], self.K, cv2.RANSAC, 0.999, 0.7)
        if E is None or E.shape != (3, 3):
            return 0, 0.0
        _, Rr, t, _ = cv2.recoverPose(E, self.kp[0][a], self.kp[j][b], self.K, mask=inl.copy())
        self.pose = {0: (np.eye(3), np.zeros(3)), j: (Rr, t.ravel())}
        self.obs = [dict() for _ in range(self.N)]
        self.X, self.XC = [], []
        n = self.triangulate(0, j)
        if n == 0:
            return 0, 0.0
        # Median parallax of the init points: a drone turning on the spot gives none, and then there is no depth to solve.
        P = np.array(self.X)
        c2 = -Rr.T @ t.ravel()
        cos = (P * (P - c2)).sum(1) / np.linalg.norm(P, axis=1) / np.linalg.norm(P - c2, axis=1)
        return n, float(np.degrees(np.median(np.arccos(np.clip(cos, -1, 1)))))

    def register(self, j, refs):
        o3, o2 = [], []
        for i in refs:
            a, b = self.match(i, j)
            for p, q in zip(a, b):
                if p in self.obs[i]:
                    o3.append(self.obs[i][p])
                    o2.append(q)
        if len(o3) < 30:
            return 0
        o3 = np.array(o3)
        o2 = np.array(o2)
        _, u = np.unique(o2, return_index=True)
        o3, o2 = o3[u], o2[u]
        X = np.array(self.X)
        ok, rv, tv, inl = cv2.solvePnPRansac(X[o3], self.kp[j][o2], self.K, None, reprojectionError=2.0,
                                             iterationsCount=2000, flags=cv2.SOLVEPNP_EPNP)
        if not ok or inl is None or len(inl) < 20:
            return 0
        inl = inl.ravel()
        rv, tv = cv2.solvePnPRefineLM(X[o3[inl]], self.kp[j][o2[inl]], self.K, None, rv, tv)
        self.pose[j] = (cv2.Rodrigues(rv)[0], tv.ravel())
        for p, q in zip(o3[inl], o2[inl]):
            self.obs[j][q] = p
        return len(inl)

    def reprojection(self):
        X = np.array(self.X)
        errs = []
        for j in self.pose:
            ids = np.array(list(self.obs[j].items()))
            if len(ids):
                errs += list(np.linalg.norm(self.proj(*self.pose[j], X[ids[:, 1]]) - self.kp[j][ids[:, 0]], axis=1))
        return float(np.median(errs)) if errs else float("inf")


def solve(images, fps, focal=None, count=4000, log=print, matcher="flann", refs=3, deadline=None):
    """Solves the camera of every frame. Returns cameras (R camera->world, C) in solve units, points, colours and stats.

    Speed (ADR 0093, solve speed): run.py hands this 1280-wide frames; 4000 SIFT features a frame and FLANN matching
    (approximate KD-tree search) instead of brute force solve the prototype clip 4x faster on 2 cores with the same
    camera path (within 0.43 m over 180 m) and the same road measurement (91.4 m against 91.6 m).

    `deadline`: (monotonic time, budget seconds). Once the frames registered so far say the rest will not finish by
    then, the solve stops with "too-slow" rather than running into the worker's step deadline.
    """
    if len(images) < 6:
        raise SolveError("too-short", "The clip is too short to read in 3D. Use at least 3 seconds of drone footage.")
    h, w = images[0].shape[:2]
    K = intrinsics(w, h, focal)
    s = Solver(images, K, count, matcher, deadline)
    log("features %d per frame" % int(np.mean([len(k) for k in s.kp])))
    # Init on a ~4 s baseline (12 frames at 3 fps), shorter when the clip is short or the pair is weak.
    best = None
    for seconds in (4.0, 3.0, 5.0, 2.0):
        j = int(round(seconds * fps))
        if j >= s.N or j < 2:
            continue
        n, parallax = s.init(j)
        log("init 0-%d: %d points, parallax %.2f deg" % (j, n, parallax))
        if n >= 300 and parallax >= 1.0:
            best = j
            break
    if best is None:
        raise SolveError("no-parallax", "The drone turns on the spot or barely moves in this clip, so there is no depth to "
                                        "read. Use a clip where the drone flies forward or sideways for a few seconds.")
    order = [j for j in range(1, s.N) if j != best]
    failed = []
    loop_started = time.monotonic()
    for done, j in enumerate(order):
        if deadline is not None and overruns(time.monotonic(), loop_started, done, len(order) - done, deadline[0]):
            log("too slow: %d of %d frames in %.0f s" % (done, len(order), time.monotonic() - loop_started))
            raise too_slow(deadline[1])
        near = sorted([i for i in s.pose if i != j], key=lambda i: abs(i - j))[:refs]
        n = s.register(j, near)
        if not n:
            failed.append(j)
            continue
        gap = max(2, int(round(2.0 * fps)))
        back = [i for i in s.pose if i != j and abs(i - j) >= gap]
        if back:
            s.triangulate(min(back, key=lambda i: abs(abs(i - j) - gap)), j)
    if len(s.pose) < 0.8 * s.N:
        raise SolveError("lost-track", "Could only follow %d of %d moments of the flight. A steadier, slower pass over the "
                                       "land works best." % (len(s.pose), s.N))
    X = np.array(s.X)
    cams = {}
    for j, (Rw, t) in s.pose.items():
        cams[j] = (Rw.T, -Rw.T @ t)  # camera -> world rotation, centre
    # Depth order in frame 0: the bottom of a forward-down view is nearer than its middle. A depth-reversed model (the
    # COLMAP failure) gives > 1.
    R0, C0 = cams[0]
    Xc = (X - C0) @ R0
    z = Xc[:, 2]
    v = Xc[:, 1] / z * K[1, 1] + K[1, 2]
    ok = z > 0
    bottom = ok & (v > 0.74 * h)
    middle = ok & (v > 0.32 * h) & (v < 0.51 * h)
    order_ratio = float(np.median(z[bottom]) / np.median(z[middle])) if bottom.sum() > 20 and middle.sum() > 20 else None
    stats = {"frames": s.N, "registered": len(s.pose), "failed": failed, "points": int(len(X)),
             "medianReprojectionPx": round(s.reprojection(), 3), "depthOrder": None if order_ratio is None else round(order_ratio, 3),
             "initFrame": best}
    log("registered %d of %d, points %d, median reprojection %.2f px, depth order %s" %
        (len(s.pose), s.N, len(X), stats["medianReprojectionPx"], stats["depthOrder"]))
    if order_ratio is not None and order_ratio >= 1.0:
        raise SolveError("depth-reversed", "The 3D reading came out inside-out (the near ground looked further away than the "
                                           "horizon). Try a clip with the camera tilted further down.")
    return {"K": K, "width": w, "height": h, "cameras": cams, "X": X, "colours": np.array(s.XC), "stats": stats}
