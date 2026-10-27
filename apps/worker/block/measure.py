# The solve made metric and level (ADR 0093), from the au-land-maya prototype's terrain.py and layout.py:
#  gravity: a gimbal keeps the horizon level, so world up is perpendicular to every camera's right vector;
#  ground:  RANSAC plane through the points under the lower part of the first frame, within 20 deg of that up;
#  world:   origin on the ground under the first camera, y up, -z the first camera's heading on the ground, metres;
#  scale:   one number nobody can read from pixels alone. Until the person gives a known length or the drone's height,
#           the first camera is assumed to fly ASSUMED_ALTITUDE_M above the ground, and the result says so;
#  sun:     NOT estimated here. Two shadow estimators (per-tree darkest bearing; a global search over sun hypotheses scoring
#           the ground where every tall point's shadow would fall) were tried on the prototype clip and both were confidently
#           wrong (250 deg against the hand-measured 137 deg): dark tree crowns read as shadows. So the sun is a default the
#           person turns on the pin screen, flagged "assumed" (ADR 0093, follow-ups).
import numpy as np

ASSUMED_ALTITUDE_M = 60.0
DEFAULT_SUN = {"azimuthDeg": 135.0, "elevationDeg": 35.0}


def gravity_up(cams, normal=None, weight=0.02):
    """World up: perpendicular to every camera's right vector (a gimbal keeps the horizon level). When the drone barely
    yaws, the right vectors all point the same way and only fix the roll; then the ground's normal (`normal`, weighted
    lightly) picks the pitch. With a turning flight the right vectors decide on their own."""
    rights = np.array([R[:, 0] for R, _ in cams.values()])
    M = rights.T @ rights / len(rights)
    if normal is not None:
        M = M - weight * np.outer(normal, normal)
    up = np.linalg.eigh(M)[1][:, 0]
    R0 = cams[0][0]
    if up @ R0[:, 1] > 0:  # image-down points away from up
        up = -up
    return up


def ground_plane(cams, X, K, height, up, seed=1):
    R0, C0 = cams[0]
    Xc = (X - C0) @ R0
    v = Xc[:, 1] / Xc[:, 2] * K[1, 1] + K[1, 2]
    u = Xc[:, 0] / Xc[:, 2] * K[0, 0] + K[0, 2]
    lower = (Xc[:, 2] > 0) & (v > 0.555 * height) & (v < height) & (u > 0) & (u < 2 * K[0, 2])
    G = X[lower]
    if len(G) < 30:
        G = X[Xc[:, 2] > 0]
    rng = np.random.default_rng(seed)
    best = (0, None)
    spread = np.median(np.linalg.norm(G - G.mean(0), axis=1))
    for _ in range(4000):
        s = G[rng.choice(len(G), 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0])
        if np.linalg.norm(n) < 1e-12:
            continue
        n /= np.linalg.norm(n)
        if abs(n @ up) < np.cos(np.radians(20)):
            continue  # only near-horizontal planes
        inl = np.abs((G - s[0]) @ n) < 0.01 * spread
        if inl.sum() > best[0]:
            best = (int(inl.sum()), inl)
    if best[1] is None:
        return up, G.mean(0), 0.0, 0.0
    inl = best[1]
    c0 = G[inl].mean(0)
    n = np.linalg.svd(G[inl] - c0)[2][2]
    if n @ up < 0:
        n = -n
    tilt = float(np.degrees(np.arccos(min(1.0, float(n @ up)))))
    return n, c0, float(inl.mean()), tilt


def world(sol, altitude_m=None):
    """Cameras and points in metres, level, origin on the ground under the first camera."""
    cams, X, K = sol["cameras"], sol["X"], sol["K"]
    n, c0, share, _ = ground_plane(cams, X, K, sol["height"], gravity_up(cams))
    up = gravity_up(cams, n)
    tilt = float(np.degrees(np.arccos(min(1.0, abs(float(n @ up))))))
    R0, C0 = cams[0]
    O = C0 - ((C0 - c0) @ n) * n
    fwd = R0[:, 2] - (R0[:, 2] @ n) * n
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, n)
    right /= np.linalg.norm(right)
    B = np.stack([right, n, -fwd])  # rows: world x, y, z in solve coordinates
    height_units = float((C0 - c0) @ n)
    if height_units <= 0:
        raise ValueError("ground above the camera")
    basis = "stated" if altitude_m else "assumed"
    scale = (altitude_m or ASSUMED_ALTITUDE_M) / height_units

    def W(x):
        return ((np.asarray(x) - O) @ B.T) * scale

    out_cams = {j: (B @ R, W(C)) for j, (R, C) in cams.items()}
    Xm = W(X)
    return {"cameras": out_cams, "points": Xm, "scale": {"metresPerUnit": scale, "altitudeM": float(out_cams[0][1][1]),
            "basis": basis}, "ground": {"inlierShare": round(share, 3), "tiltFromGravityDeg": round(tilt, 2)}}


def project(R, C, K, P):
    Xc = (np.atleast_2d(P) - C) @ R
    uv = Xc[:, :2] / Xc[:, 2:3] * [K[0, 0], K[1, 1]] + [K[0, 2], K[1, 2]]
    return uv, Xc[:, 2]
