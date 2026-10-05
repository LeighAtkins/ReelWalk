"""Writes a camera path for a vertical flythrough of a trained splat.

The photos of a capture are taken from a path through the room, but a jittery
one: the photographer stops, tilts and turns. This smooths that path into a
steady move with a level horizon and saves it in the format `ns-render
camera-path` reads. Staying close to where the photos were taken matters: a
splat only looks right from near the viewpoints it was trained on.

    python flythrough.py <config.yml> <camera-path.json> [seconds]
"""

import json
import sys
from pathlib import Path

import numpy as np
from nerfstudio.utils.eval_utils import eval_setup

FPS = 30
WIDTH, HEIGHT = 1080, 1920
VERTICAL_FOV = 70.0
# How far the smoothing reaches, in photos. Larger is steadier but cuts corners.
SMOOTH_PHOTOS = 7.0
# Photographers look down a lot. Keep a fraction of that tilt.
PITCH_KEPT = 0.35


def smooth(values: np.ndarray, sigma: float) -> np.ndarray:
    radius = int(sigma * 3)
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(values, ((radius, radius), (0, 0)), mode="edge")
    return np.stack([np.convolve(padded[:, axis], kernel, mode="valid") for axis in range(values.shape[1])], axis=1)


def unit(vectors: np.ndarray) -> np.ndarray:
    return vectors / np.linalg.norm(vectors, axis=-1, keepdims=True)


def main() -> None:
    config, output = Path(sys.argv[1]), Path(sys.argv[2])
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0

    _, pipeline, _, _ = eval_setup(config, test_mode="inference")
    poses = pipeline.datamanager.train_dataset.cameras.camera_to_worlds.cpu().numpy()
    positions = poses[:, :3, 3]
    # Cameras look down their own -z axis; the scene is oriented with z up.
    forwards = -poses[:, :3, 2]

    positions = smooth(positions, SMOOTH_PHOTOS)
    forwards = unit(smooth(forwards, SMOOTH_PHOTOS))
    forwards[:, 2] *= PITCH_KEPT
    forwards = unit(forwards)

    # Constant apparent speed: step evenly through moving and turning together,
    # so standing still to pan does not become a sudden spin.
    moved = np.linalg.norm(np.diff(positions, axis=0), axis=1)
    turned = np.arccos(np.clip(np.sum(forwards[1:] * forwards[:-1], axis=1), -1, 1))
    effort = moved / max(moved.mean(), 1e-9) + turned / max(turned.mean(), 1e-9)
    along = np.concatenate([[0.0], np.cumsum(effort)])
    frames = int(seconds * FPS)
    # Ease in and out of the move.
    progress = np.linspace(0, 1, frames)
    progress = progress * progress * (3 - 2 * progress)
    at = progress * along[-1]

    up = np.array([0.0, 0.0, 1.0])
    cameras = []
    for target in at:
        position = np.array([np.interp(target, along, positions[:, axis]) for axis in range(3)])
        forward = unit(np.array([np.interp(target, along, forwards[:, axis]) for axis in range(3)]))
        right = unit(np.cross(forward, up))
        true_up = np.cross(right, forward)
        matrix = np.eye(4)
        matrix[:3, 0], matrix[:3, 1], matrix[:3, 2], matrix[:3, 3] = right, true_up, -forward, position
        cameras.append({"camera_to_world": matrix.flatten().tolist(), "fov": VERTICAL_FOV, "aspect": WIDTH / HEIGHT})

    output.write_text(
        json.dumps(
            {
                "camera_type": "perspective",
                "render_width": WIDTH,
                "render_height": HEIGHT,
                "fps": FPS,
                "seconds": seconds,
                "camera_path": cameras,
            }
        )
    )
    print(f"{frames} frames along {len(poses)} photos -> {output}")


if __name__ == "__main__":
    main()
