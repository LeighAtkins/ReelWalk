#!/usr/bin/env bash
# Encodes .audio-wav/<voice>/*.wav (from generate-audio.mts) to public/audio/<voice>/*.mp3,
# using the ffmpeg in an image (default: reelwalk-worker) so the host needs none.
# Encoded WAVs are deleted.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${FFMPEG_IMAGE:-reelwalk-worker:latest}"
mkdir -p public/audio
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/w" -w /w --entrypoint bash "$image" -c '
  n=0
  for f in .audio-wav/*/*.wav; do
    [ -e "$f" ] || continue
    v=$(basename "$(dirname "$f")")
    k=$(basename "$f" .wav)
    mkdir -p "public/audio/$v"
    ffmpeg -nostdin -y -loglevel error -i "$f" -ac 1 -ar 24000 -codec:a libmp3lame -b:a 40k "public/audio/$v/$k.mp3" && rm "$f"
    n=$((n+1))
  done
  echo "encoded $n files"
'
