#!/usr/bin/env bash
# Turns a multi-view capture of a room into a 3D Gaussian splat and renders a
# vertical flythrough of it. Runs inside the nerfstudio image on an NVIDIA GPU.
#
#   curl -L -o data/splat/tandt_db.zip https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/datasets/input/tandt_db.zip
#   mkdir -p data/splat/tandt_db && tar -xf data/splat/tandt_db.zip -C data/splat/tandt_db db/playroom
#   docker run --rm --gpus all --shm-size 8g \
#     -v "$PWD/data/splat:/data" -v "$PWD/infra/splat:/scripts:ro" \
#     ghcr.io/nerfstudio-project/nerfstudio:latest bash /scripts/reconstruct.sh playroom
#   docker compose run --rm import-flythrough
#
# Input is a set of overlapping photos with camera poses from COLMAP. The
# sample scenes ("playroom", "drjohnson": rooms in real homes, about 250
# photos each) come from the dataset published with the 3D Gaussian Splatting
# paper. A phone walkthrough video becomes the same kind of input with
# `ns-process-data video`.
#
# The scene is unpacked on the host: unpacking it from inside the container
# onto a Windows bind mount runs out of memory.
set -euo pipefail

SCENE="${1:-playroom}"
ITERATIONS="${ITERATIONS:-7000}"
SECONDS_LONG="${SECONDS_LONG:-14}"
DATA="/data/tandt_db/db/${SCENE}"
OUT="/data/out"
CONFIG="${OUT}/${SCENE}/splatfacto/run/config.yml"

if [ ! -d "${DATA}/sparse/0" ]; then
  echo "missing ${DATA}: download and unpack the scene first (see the top of this file)" >&2
  exit 1
fi
echo "== photos: $(ls "${DATA}/images" | wc -l)"

if [ -f "${CONFIG}" ] && [ -z "${RETRAIN:-}" ]; then
  echo "== already trained (RETRAIN=1 to train again)"
else
  echo "== training (${ITERATIONS} iterations)"
  start=$(date +%s)
  ns-train splatfacto \
    --output-dir "${OUT}" \
    --experiment-name "${SCENE}" \
    --timestamp run \
    --max-num-iterations "${ITERATIONS}" \
    --viewer.quit-on-train-completion True \
    colmap --data "${DATA}" --images-path images --colmap-path sparse/0 --downscale-factor 1
  echo "== trained in $(( $(date +%s) - start ))s"
fi

echo "== rendering a ${SECONDS_LONG}s vertical flythrough"
start=$(date +%s)
python /scripts/flythrough.py "${CONFIG}" "/data/${SCENE}-path.json" "${SECONDS_LONG}"
ns-render camera-path \
  --load-config "${CONFIG}" \
  --camera-path-filename "/data/${SCENE}-path.json" \
  --output-path "/data/${SCENE}-reel.mp4"
echo "== rendered in $(( $(date +%s) - start ))s"
ls -la "/data/${SCENE}-reel.mp4"
