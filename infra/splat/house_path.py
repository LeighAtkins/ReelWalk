"""Turns a reel's camera route into a camera path for rendering the house splat.

The app exports where the camera is for every frame of a tour reel, in floor
plan coordinates (apps/worker/src/export-camera-path.ts). This converts those
poses to the splat's own coordinates and writes the file `ns-render
camera-path` reads, so the splat is filmed along exactly the route of the
reel's 360 walk.

    python house_path.py <tour folder> <poses.json> <splat config.yml> <camera-path.json>
"""

import json
import math
import sys
from pathlib import Path

import numpy as np


def main() -> None:
    tour, poses_file, config, output = (Path(argument) for argument in sys.argv[1:5])
    data = json.loads((tour / "zind_data.json").read_text())
    floor = next(iter(data["merger"]))
    metres = data["scale_meters_per_coordinate"][floor]

    # The plan's box, as the app normalises it: positions are fractions of this box.
    corners = np.array([vertex for room in data["redraw"][floor].values() for vertex in room["vertices"]])
    low = corners.min(axis=0)
    size = corners.max(axis=0) - low

    # Camera height: the tour's cameras all stand at one height.
    pano = next(iter(next(iter(next(iter(data["merger"][floor].values())).values())).values()))
    eye = pano["camera_height"] * pano["floor_plan_transformation"]["scale"] * metres

    # The trainer recentres and rescales the scene; the same change applies to the path.
    applied = json.loads((config.parent / "dataparser_transforms.json").read_text())
    transform = np.array(applied["transform"])
    scale = applied["scale"]

    path = json.loads(poses_file.read_text())
    cameras = []
    for pose in path["poses"]:
        position = np.array([(low[0] + pose["x"] * size[0]) * metres, -(low[1] + pose["y"] * size[1]) * metres, eye])
        yaw, pitch = math.radians(pose["heading"]), math.radians(pose["pitch"])
        forward = np.array([math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)])
        right = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
        up = np.cross(right, forward)
        world = np.eye(4)
        world[:3, :3] = np.stack([right, up, -forward], axis=1)
        world[:3, 3] = position
        placed = np.eye(4)
        placed[:3] = transform @ world
        placed[:3, 3] *= scale
        cameras.append({"camera_to_world": placed.flatten().tolist(), "fov": pose["fov"], "aspect": path["width"] / path["height"]})

    output.write_text(
        json.dumps(
            {
                "camera_type": "perspective",
                "render_width": path["width"],
                "render_height": path["height"],
                "fps": path["fps"],
                "seconds": len(cameras) / path["fps"],
                "camera_path": cameras,
            }
        )
    )
    print(f"{len(cameras)} frames -> {output}")


if __name__ == "__main__":
    main()
