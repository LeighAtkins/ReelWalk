"""Turns a home tour of 360 photos into a dataset a Gaussian splat can be trained on.

A splat is normally built from a hundred or more overlapping photos, whose
overlap reveals the depth of everything in them. A tour has one or two 360
photos per room, which is nowhere near enough. What a tour in ZInD format has
instead is knowledge: where each photo was taken, which way it faces, and the
outline and height of the room around it. This script uses that in place of
overlap:

1. Each 360 photo is cut into 18 ordinary camera views (6 directions, 3
   tilts), each with an exact camera pose.
2. A depth model estimates how far away every pixel is. Such a model only
   knows relative depth, so each view is fitted to the distances the room's
   own walls, floor and ceiling give. Where the two agree, the room's exact
   surface is used; where they differ (a door leaf, a cabinet, a worktop, the
   view through a doorway) the model's depth is kept.
3. Every view's pixels are placed in 3D at their depth. That cloud of
   coloured points is what the splat starts from.

World coordinates are metres: x to the right of the plan, y up the plan, z up.

    python panos_to_dataset.py <tour folder> <output folder>
"""

import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
import open3d as o3d
import torch
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

VIEW = 512  # pixels: a 90 degree view of a 2048 pixel wide 360 photo is 512 pixels across
FOV = 90.0
YAWS = range(0, 360, 60)
PITCHES = (-40.0, 0.0, 40.0)
POINTS_PER_VIEW = 5000
DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Base-hf"
NEAR, FAR = 0.25, 15.0
# The depth model and the room shape count as agreeing within this fraction.
AGREE = 0.25


def load_tour(tour: Path):
    data = json.loads((tour / "zind_data.json").read_text())
    floor = next(iter(data["merger"]))
    metres = data["scale_meters_per_coordinate"][floor]
    panos = []
    for complete in data["merger"][floor].values():
        for partial in complete.values():
            for name, pano in partial.items():
                if not pano["is_inside"]:
                    continue
                place = pano["floor_plan_transformation"]
                r = math.radians(place["rotation"])
                scale = place["scale"]
                # Same convention as the importer (apps/worker/src/import-zind.ts).
                heading = math.atan2(-math.sin(r), -math.cos(r))
                complete_shape = (pano.get("layout_complete") or {}).get("vertices") or []
                shape = complete_shape if len(complete_shape) >= 3 else pano["layout_raw"]["vertices"]
                outline = []
                for x, y in shape:
                    gx = (x * math.cos(r) - y * math.sin(r)) * scale + place["translation"][0]
                    gy = (x * math.sin(r) + y * math.cos(r)) * scale + place["translation"][1]
                    outline.append((gx * metres, -gy * metres))
                panos.append(
                    {
                        "name": name,
                        "image": tour / pano["image_path"],
                        "position": np.array(
                            [place["translation"][0] * metres, -place["translation"][1] * metres, pano["camera_height"] * scale * metres]
                        ),
                        "heading": heading,
                        "ceiling": pano["ceiling_height"] * scale * metres,
                        "outline": np.array(outline),
                    }
                )
    return panos


def view_rotation(yaw: float, pitch: float) -> np.ndarray:
    """Camera-to-world rotation for a camera facing `yaw` (clockwise from the top of the plan), tilted up by `pitch`."""
    forward = np.array([math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)])
    right = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
    up = np.cross(right, forward)
    # Columns: the camera's x (right), y (up) and z (backwards).
    return np.stack([right, up, -forward], axis=1)


def rays(rotation: np.ndarray, focal: float) -> np.ndarray:
    """Unit direction in the world of every pixel of a view."""
    u, v = np.meshgrid(np.arange(VIEW) + 0.5, np.arange(VIEW) + 0.5)
    camera = np.stack([(u - VIEW / 2) / focal, -(v - VIEW / 2) / focal, -np.ones_like(u)], axis=-1)
    world = camera @ rotation.T
    return world / np.linalg.norm(world, axis=-1, keepdims=True)


def cut_view(photo: np.ndarray, directions: np.ndarray, heading: float) -> np.ndarray:
    height, width = photo.shape[:2]
    lon = np.arctan2(directions[..., 0], directions[..., 1]) - heading
    lat = np.arcsin(np.clip(directions[..., 2], -1, 1))
    x = ((lon / (2 * math.pi) + 0.5) % 1.0) * width - 0.5
    y = (0.5 - lat / math.pi) * height - 0.5
    return cv2.remap(photo, x.astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def room_distance(pano, directions: np.ndarray):
    """
    Distance along each ray to the room's wall, floor or ceiling, from where
    the photo was taken; and to the floor or ceiling alone, which nothing is
    ever beyond.
    """
    origin = pano["position"]
    dz = directions[..., 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        flat = np.where(dz < -1e-6, -origin[2] / dz, np.where(dz > 1e-6, (pano["ceiling"] - origin[2]) / dz, np.inf))
    nearest = np.full(dz.shape, np.inf)
    outline = pano["outline"]
    for index in range(len(outline)):
        p, q = outline[index], outline[(index + 1) % len(outline)]
        edge = q - p
        denominator = directions[..., 0] * edge[1] - directions[..., 1] * edge[0]
        to = p - origin[:2]
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (to[0] * edge[1] - to[1] * edge[0]) / denominator
            s = (to[0] * directions[..., 1] - to[1] * directions[..., 0]) / denominator
        hit = (np.abs(denominator) > 1e-9) & (t > 1e-6) & (s >= 0) & (s <= 1)
        nearest = np.where(hit & (t < nearest), t, nearest)
    return np.minimum(nearest, flat), flat


def fit_depth(relative: np.ndarray, room: np.ndarray, flat: np.ndarray) -> np.ndarray:
    """
    Distances for a view: the model's relative inverse depth, scaled and
    shifted to fit the room, with the room's own surface wherever they agree.
    """
    known = np.isfinite(room) & (room > NEAR) & (room < FAR)
    target = np.where(known, 1.0 / np.maximum(room, 1e-6), 0.0)
    keep = known.copy()
    a, b = 1.0, 0.0
    for _ in range(4):
        if keep.sum() < 100:
            break
        design = np.stack([relative[keep], np.ones(keep.sum())], axis=1)
        a, b = np.linalg.lstsq(design, target[keep], rcond=None)[0]
        residual = np.abs(a * relative + b - target)
        # Things standing in the room are nearer than its walls; leave them out of the next fit.
        keep = known & (residual < 1.5 * np.median(residual[keep]) + 1e-6)
    estimated = np.minimum(1.0 / np.clip(a * relative + b, 1.0 / FAR, 1.0 / NEAR), flat)
    # A fit that does not even explain the walls says nothing about what stands in front of them.
    spread = np.median(np.abs(estimated - room)[known] / room[known]) if known.any() else np.inf
    if spread > 0.08:
        return np.where(known, room, estimated)
    agree = known & (np.abs(estimated - room) < AGREE * room)
    return np.where(agree, room, estimated)


def main() -> None:
    tour, out = Path(sys.argv[1]), Path(sys.argv[2])
    (out / "images").mkdir(parents=True, exist_ok=True)
    panos = load_tour(tour)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = AutoImageProcessor.from_pretrained(DEPTH_MODEL)
    model = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL).to(device).eval()

    focal = VIEW / 2 / math.tan(math.radians(FOV) / 2)
    generator = np.random.default_rng(0)
    frames, points, colours = [], [], []
    for pano in panos:
        photo = cv2.imread(str(pano["image"]))
        for yaw_degrees in YAWS:
            for pitch_degrees in PITCHES:
                rotation = view_rotation(math.radians(yaw_degrees), math.radians(pitch_degrees))
                directions = rays(rotation, focal)
                image = cut_view(photo, directions, pano["heading"])
                name = f"{pano['name']}_y{yaw_degrees:03d}_p{int(pitch_degrees):+03d}.jpg"
                cv2.imwrite(str(out / "images" / name), image, [cv2.IMWRITE_JPEG_QUALITY, 95])

                with torch.no_grad():
                    inputs = processor(images=cv2.cvtColor(image, cv2.COLOR_BGR2RGB), return_tensors="pt").to(device)
                    predicted = model(**inputs).predicted_depth
                    relative = torch.nn.functional.interpolate(predicted[None], size=(VIEW, VIEW), mode="bicubic", align_corners=False)[0, 0]
                room, flat = room_distance(pano, directions)
                distance = fit_depth(relative.cpu().numpy().astype(np.float64), room, flat)

                # Pixels on a jump in depth belong to neither side: leave them out.
                jump = np.maximum(np.abs(np.gradient(distance, axis=0)), np.abs(np.gradient(distance, axis=1))) / distance
                usable = np.flatnonzero((jump < 0.05).ravel())
                chosen = generator.choice(usable, size=min(POINTS_PER_VIEW, len(usable)), replace=False)
                points.append(pano["position"] + directions.reshape(-1, 3)[chosen] * distance.ravel()[chosen, None])
                colours.append(image.reshape(-1, 3)[chosen, ::-1] / 255.0)

                transform = np.eye(4)
                transform[:3, :3] = rotation
                transform[:3, 3] = pano["position"]
                frames.append({"file_path": f"images/{name}", "transform_matrix": transform.tolist()})
        print(f"{pano['name']}: {len(YAWS) * len(PITCHES)} views", flush=True)

    cloud = o3d.geometry.PointCloud()
    cloud.points = o3d.utility.Vector3dVector(np.concatenate(points))
    cloud.colors = o3d.utility.Vector3dVector(np.concatenate(colours))
    o3d.io.write_point_cloud(str(out / "points.ply"), cloud)
    (out / "transforms.json").write_text(
        json.dumps(
            {
                "camera_model": "OPENCV",
                "fl_x": focal,
                "fl_y": focal,
                "cx": VIEW / 2,
                "cy": VIEW / 2,
                "w": VIEW,
                "h": VIEW,
                "ply_file_path": "points.ply",
                "frames": frames,
            }
        )
    )
    print(f"{len(panos)} photos -> {len(frames)} views, {sum(len(p) for p in points)} points")


if __name__ == "__main__":
    main()
