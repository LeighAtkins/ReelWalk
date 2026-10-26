#!/usr/bin/env bash
# Render QA (ADR 0082), report only. Two open-source checks, pinned:
#   remotion-qa 0.1.3 (MIT, github.com/GroMarketing/remotion-qa): pace (static runs) and the Reels safe zone, on every
#     MP4 in <dir> (the worker smoke's export in CI).
#   audio-bed-check 0.1.0 (MIT, github.com/oo-pibe/audio-bed-check): loop and level-step checks on the bundled ambience
#     beds, each looped to 20 s the way a reel plays it (SFX_SOUNDS loops them; ADR 0066).
# Usage: render-qa.sh <dir with MP4s>   Exit 1 if any check fails, 2 if a tool could not run. Writes qa-report.md there.
set -uo pipefail
DIR="$(cd "${1:?dir with MP4s}" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
SFX="$HERE/../../public/sfx"
WORK="$(mktemp -d)"
REPORT="$DIR/qa-report.md"
status=0

npm install --prefix "$WORK/node" --no-save --no-audit --no-fund remotion-qa@0.1.3 >/dev/null 2>&1 || { echo "remotion-qa did not install"; exit 2; }
FFMPEG="$(node -e "console.log(require('$WORK/node/node_modules/ffmpeg-static'))")"
python3 -m venv "$WORK/py" && "$WORK/py/bin/pip" install -q audio-bed-check==0.1.0 || { echo "audio-bed-check did not install"; exit 2; }

{
  echo "## Render QA (report only, ADR 0082)"
  echo
  echo "### remotion-qa: pace and safe zone"
  echo '```'
} > "$REPORT"
shopt -s nullglob
videos=("$DIR"/*.mp4)
if [ ${#videos[@]} -eq 0 ]; then
  echo "no MP4 in $DIR" >> "$REPORT"
else
  (cd "$WORK" && REMOTION_QA_FFMPEG="$FFMPEG" "$WORK/node/node_modules/.bin/remotion-qa" check "${videos[@]}" --frames "$DIR/qa-frames") >> "$REPORT" 2>&1 || status=1
fi
{
  echo '```'
  echo
  echo "### audio-bed-check: the ambience beds, looped to 20 s"
  echo '```'
} >> "$REPORT"
for sound in fire water wind room-tone; do
  "$FFMPEG" -v error -y -stream_loop 5 -i "$SFX/$sound.wav" -t 20 "$WORK/bed-$sound.wav"
  # The beds are 4 s files, so the repeat to look for is shorter than the tool's 6 s default.
  "$WORK/py/bin/audio-bed-check" bed "$WORK/bed-$sound.wav" --min-period 3 --ffmpeg "$FFMPEG" >> "$REPORT" 2>&1 || status=1
done
echo '```' >> "$REPORT"

cat "$REPORT"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$REPORT" >> "$GITHUB_STEP_SUMMARY"
rm -rf "$WORK"
exit $status
