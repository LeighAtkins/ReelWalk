#!/usr/bin/env bash
# Smoke test for the voice Worker (ADR 0038, 0099): every voice the app offers, plus the refusals.
#
#   VOICE_KEY=... ./smoke.sh http://localhost:8787            # against `wrangler dev --remote`
#   VOICE_KEY=... ./smoke.sh https://reelwalk-voice.<sub>.workers.dev
#
# The key is read from the environment and never printed. Each voice is one short Workers AI request.
set -euo pipefail
url="${1:?usage: VOICE_KEY=... ./smoke.sh <worker url>}"
: "${VOICE_KEY:?set VOICE_KEY}"
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

# The voices offered in the app (packages/core/src/voiceover.ts VOICES), then the presenter voice's other models.
voices=$(grep -oE '"aura-2:[a-z]+"' "$here/../../../packages/core/src/voiceover.ts" | tr -d '"' | sort -u)
line="Three bedrooms, a north-facing garden, and room to grow."
failed=0

call() { # name, expected status, body, [key]
  local name="$1" want="$2" body="$3" key="${4-$VOICE_KEY}" got type seconds
  got=$(curl -sS -m 90 -o "$out/$name" -D "$out/$name.h" -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "x-voice-key: $key" --data "$body" "$url" || echo 000)
  type=$(grep -i '^content-type:' "$out/$name.h" | tr -d '\r' | cut -d' ' -f2 || true)
  seconds=""
  if [ "$got" = 200 ] && command -v ffprobe >/dev/null; then seconds=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/$name" || true); fi
  if [ "$got" = "$want" ] && { [ "$want" != 200 ] || [ "$type" = audio/mpeg ]; }; then
    printf 'ok    %-22s HTTP %s %s%s\n' "$name" "$got" "$type" "${seconds:+ ${seconds}s}"
  else
    printf 'FAIL  %-22s HTTP %s (wanted %s) %s %s\n' "$name" "$got" "$want" "$type" "$(head -c 200 "$out/$name" | tr -d '\n')"
    failed=1
  fi
}

for voice in $voices; do call "$voice" 200 "{\"text\":\"$line\",\"voice\":\"$voice\"}"; done
call "aura-1:luna" 200 "{\"text\":\"$line\",\"voice\":\"aura-1:luna\"}"
call "melotts:en" 200 "{\"text\":\"$line\",\"voice\":\"melotts:en\"}"
call "wrong-key" 401 "{\"text\":\"$line\",\"voice\":\"aura-2:theia\"}" "not-the-key"
call "empty-text" 400 '{"text":"","voice":"aura-2:theia"}'
call "too-long" 400 "{\"text\":\"$(printf 'a%.0s' $(seq 1 401))\",\"voice\":\"aura-2:theia\"}"
call "unknown-melo-lang" 400 '{"text":"Hi.","voice":"melotts:xx"}'
exit "$failed"
