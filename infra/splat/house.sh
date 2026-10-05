#!/usr/bin/env bash
# A Gaussian splat of a whole home from its 360 photos, filmed along the route
# of a tour reel. Needs an NVIDIA GPU (about 6 GB of free memory).
#
#   docker build -t reelwalk-splat infra/splat
#   docker compose run --rm import-zind node_modules/.bin/tsx src/export-camera-path.ts sample-zind-000 > data/splat/house-poses.json
#   docker run --rm --gpus all --shm-size 8g \
#     -v "$PWD/data/zind:/zind:ro" -v "$PWD/data/splat:/data" \
#     -v reelwalk-hf:/root/.cache/huggingface -v "$PWD/infra/splat:/scripts:ro" \
#     --entrypoint bash reelwalk-splat /scripts/house.sh
#   docker compose run --rm import-flythrough
#
# A tour has one or two photos per room, far too few for a splat to work out
# depth from overlap. panos_to_dataset.py supplies the depth instead, from a
# depth model fitted to the room shapes in the tour, and the splat starts from
# those points. Three settings keep it honest about what it does not know:
#
# - Points stay where the depth put them (a learning rate of almost zero for
#   positions; exactly zero breaks the trainer's schedule) and none are added
#   or removed (the warm-up outlasts the training). Left free, the trainer
#   fills the unseen space between photos with floating blobs.
# - Blobs stay nearly round (max-gauss-ratio 2). A surface seen from one spot
#   only can be explained by needles pointing at that spot, which look like
#   streaks from anywhere else.
# - Colour does not depend on the viewing direction (sh-degree 0), for the
#   same reason.
#
# Stay under 500 views: above that the trainer keeps images in pinned system
# memory, which fails under WSL.
set -euo pipefail

TOUR="${TOUR:-/zind/sample_tour/000}"
ITERATIONS="${ITERATIONS:-6000}"
OUT="/data/out"
CONFIG="${OUT}/house/splatfacto/run/config.yml"

if [ ! -f /data/house-poses.json ]; then
  echo "missing /data/house-poses.json: export a reel's camera route first (see the top of this file)" >&2
  exit 1
fi

if [ -f "${CONFIG}" ] && [ -z "${RETRAIN:-}" ]; then
  echo "== already trained (RETRAIN=1 to train again)"
else
  echo "== cutting the 360 photos into views and estimating depth"
  rm -rf /data/house/images
  python /scripts/panos_to_dataset.py "${TOUR}" /data/house

  echo "== training (${ITERATIONS} iterations)"
  start=$(date +%s)
  rm -rf "${OUT}/house"
  ns-train splatfacto \
    --output-dir "${OUT}" \
    --experiment-name house \
    --timestamp run \
    --max-num-iterations "${ITERATIONS}" \
    --viewer.quit-on-train-completion True \
    --pipeline.model.sh-degree 0 \
    --pipeline.model.use-scale-regularization True \
    --pipeline.model.max-gauss-ratio 2 \
    --pipeline.model.warmup-length 100000 \
    --pipeline.model.camera-optimizer.mode off \
    --optimizers.means.optimizer.lr 1e-8 \
    --optimizers.means.scheduler.lr-final 1e-9 \
    nerfstudio-data --data /data/house --eval-mode interval --eval-interval 100 --load-3D-points True
  echo "== trained in $(( $(date +%s) - start ))s"
fi

echo "== rendering along the reel's route"
start=$(date +%s)
python /scripts/house_path.py "${TOUR}" /data/house-poses.json "${CONFIG}" /data/house-path.json
ns-render camera-path \
  --load-config "${CONFIG}" \
  --camera-path-filename /data/house-path.json \
  --output-path /data/house-reel.mp4
echo "== rendered in $(( $(date +%s) - start ))s"
ls -la /data/house-reel.mp4
