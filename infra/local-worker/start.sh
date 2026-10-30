#!/usr/bin/env bash
# Runs production's render worker on this PC, for our own workspaces' renders
# (ADR 0094). From any checkout of the repository, in Git Bash:
#
#   bash infra/local-worker/start.sh key      # once: make the worker's own AWS key (reelwalk-local-worker)
#   bash infra/local-worker/start.sh          # start, or move to the image production runs now
#   bash infra/local-worker/start.sh logs     # follow its log
#   bash infra/local-worker/start.sh status   # is it up, and what is it doing
#   bash infra/local-worker/start.sh stop     # stop it; queued renders move to Fargate after 10 min
#
# `key --replace` deletes the user's existing IAM keys first (when this PC no
# longer holds the one IAM has).
#
# Needs Docker Desktop and the AWS CLI with the `reelwalk` profile, which reads
# the deployed worker image, its settings and the database URL. Prints no
# secret. The worker's AWS key and the database URL are kept as files in
# ~/.reelwalk (outside every checkout) and mounted read-only into the
# container, so they are not in its environment for `docker inspect` to show.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash would rewrite /reelwalk/DATABASE_URL into a Windows path

AWS=${AWS_CLI:-aws}; command -v "$AWS" >/dev/null || AWS="/c/Program Files/Amazon/AWSCLIV2/aws.exe"
PROFILE=${AWS_PROFILE_ADMIN:-reelwalk}
REGION=us-east-2
PROJECT=reelwalk
CONTAINER=reelwalk-local-worker-worker-local-1
SECRETS=${REELWALK_SECRETS:-$HOME/.reelwalk}
LOCK=${HEAVY_LOCK_PARENT:-C:/dev/lm}/.heavy.lock
aws_admin() { "$AWS" --profile "$PROFILE" --region "$REGION" "$@"; }

# Makes the worker's AWS key, once, and only ever installs a complete one. One run at a time (a guard
# directory), reconciled with IAM (a key this PC already holds is kept; one it does not hold is only replaced
# with --replace), written to a temp file, checked, then moved into place.
make_key() {
  local replace=${1:-} user="$PROJECT-local-worker" creds="$SECRETS/aws-credentials" existing held tmp id secret
  existing=$(aws_admin iam list-access-keys --user-name "$user" --query 'AccessKeyMetadata[].AccessKeyId' --output text) \
    || { echo "could not list $user's keys; nothing changed"; return 1; }
  existing=$(tr -d '\r' <<<"$existing" | tr '\t' ' ' | sed -E 's/\bNone\b//g; s/^ +| +$//g')
  held=$(sed -nE 's/^aws_access_key_id = (\S+)\r?$/\1/p' "$creds" 2>/dev/null || true)
  if [ -n "$held" ] && [[ " $existing " == *" $held "* ]]; then echo "already set up: this PC holds $user's key $held"; return 0; fi
  if [ -n "$existing" ] && [ "$replace" != "--replace" ]; then
    echo "IAM has key(s) for $user that this PC does not hold: $existing. 'start.sh key --replace' deletes them and makes a new one."
    return 1
  fi
  for id in $existing; do aws_admin iam delete-access-key --user-name "$user" --access-key-id "$id" || { echo "could not delete $id"; return 1; }; done
  tmp=$(mktemp "$SECRETS/.aws-credentials.XXXXXX")
  if ! read -r id secret < <(aws_admin iam create-access-key --user-name "$user" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text | tr -d '\r'); then
    rm -f "$tmp"; echo "could not create the key; nothing installed"; return 1
  fi
  printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$id" "$secret" > "$tmp"
  if ! grep -qE '^aws_access_key_id = A[A-Z0-9]{15,}$' "$tmp" || ! grep -qE '^aws_secret_access_key = \S{30,}$' "$tmp"; then
    rm -f "$tmp"; echo "the new key did not look right; nothing installed (delete it in IAM: $id)"; return 1
  fi
  mv -f "$tmp" "$creds"
  echo "wrote $user's key $id to $creds"
}

# A heavy lock our worker left when its container went away (a crash, an OOM kill, a reboot, a recreate)
# would hold up every heavy job on this PC. It is removed only on positive proof: owner.txt names our worker
# and a full container id that Docker reports as not running or as gone. Any Docker error leaves it alone.
# The removal is a rename (atomic) checked against the owner.txt that was judged, and our cleaners take a
# .cleanup guard first; a mismatch puts the lock back.
clear_dead_lock() {
  local holder cid state tomb guard="$LOCK.cleanup"
  holder=$(cat "$LOCK/owner.txt" 2>/dev/null) || return 0
  case "$holder" in "reelwalk-local-worker "*) ;; *) return 0;; esac
  cid=$(sed -nE 's/.* container=([0-9a-f]{64}) .*/\1/p' <<<"$holder")
  [ -n "$cid" ] || return 0
  if state=$(docker inspect --format '{{.State.Running}}' "$cid" 2>&1); then
    [ "$state" = "false" ] || return 0
  else
    case "$state" in
      *"No such object"*|*"No such container"*) ;;
      *) echo "could not check container ${cid:0:12}; leaving the heavy lock alone"; return 0;;
    esac
  fi
  mkdir "$guard" 2>/dev/null || return 0
  tomb="$LOCK.dead-$$-$RANDOM"
  if mv "$LOCK" "$tomb" 2>/dev/null; then
    if [ "$(cat "$tomb/owner.txt" 2>/dev/null)" = "$holder" ]; then
      rm -rf "$tomb"
      echo "removed a heavy lock left by a stopped worker container (${cid:0:12})"
    else
      mv "$tomb" "$LOCK" 2>/dev/null || echo "WARNING: moved a live heavy lock aside and could not put it back: $tomb"
    fi
  fi
  rmdir "$guard" 2>/dev/null || true
}

start_worker() {
  docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop first"; exit 1; }
  [ -f "$SECRETS/aws-credentials" ] || { echo "no worker key yet: run 'bash infra/local-worker/start.sh key' once"; exit 1; }
  [ -d "${LOCK%/.heavy.lock}" ] || { echo "${LOCK%/.heavy.lock} does not exist: create it (mkdir -p /c/dev/lm) or set HEAVY_LOCK_PARENT"; exit 1; }

  # The worker production runs right now: same image (so it matches the database schema) and same settings.
  local family="$PROJECT-worker" registry
  REELWALK_WORKER_IMAGE=$(aws_admin ecs describe-task-definition --task-definition "$family" --query 'taskDefinition.containerDefinitions[0].image' --output text | tr -d '\r')
  aws_admin ecs describe-task-definition --task-definition "$family" \
    --query 'taskDefinition.containerDefinitions[0].environment[].[name,value]' --output text | tr -d '\r' | sed -E 's/\t/=/' > .env.task
  grep -q '^LOCAL_RENDER_QUEUE_URL=' .env.task || {
    echo "the deployed worker ($REELWALK_WORKER_IMAGE) predates local rendering (ADR 0094); deploy it first"; exit 1; }
  LOCAL_RENDER_QUEUE_URL=$(aws_admin sqs get-queue-url --queue-name "$PROJECT-render-jobs-local" --query QueueUrl --output text | tr -d '\r')
  LOCAL_RENDER_DLQ_URL=$(aws_admin sqs get-queue-url --queue-name "$PROJECT-render-jobs-local-dlq" --query QueueUrl --output text | tr -d '\r')
  # Straight from SSM into its file, never through a variable or the terminal.
  ( umask 077; aws_admin ssm get-parameter --name "/$PROJECT/DATABASE_URL" --with-decryption --query Parameter.Value --output text | tr -d '\r\n' > "$SECRETS/database-url" )
  [ -s "$SECRETS/database-url" ] || { echo "could not read the database URL from SSM"; exit 1; }
  REELWALK_SECRETS_DIR=$(cygpath -m "$SECRETS" 2>/dev/null || echo "$SECRETS")
  export REELWALK_WORKER_IMAGE LOCAL_RENDER_QUEUE_URL LOCAL_RENDER_DLQ_URL REELWALK_SECRETS_DIR

  if ! docker image inspect "$REELWALK_WORKER_IMAGE" >/dev/null 2>&1; then
    registry=${REELWALK_WORKER_IMAGE%%/*}
    aws_admin ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
    echo "pulling ${REELWALK_WORKER_IMAGE##*/}"
    docker pull -q "$REELWALK_WORKER_IMAGE" >/dev/null
  fi

  docker compose -f compose.yml up -d --remove-orphans
  clear_dead_lock
  echo "local worker up: ${REELWALK_WORKER_IMAGE##*:} on ${LOCAL_RENDER_QUEUE_URL##*/}"
  echo "follow it with: bash infra/local-worker/start.sh logs"
}

main() {
  cd "$(dirname "$0")"
  # These need no settings, so they work from a fresh shell.
  case "${1:-start}" in
    stop) docker stop -t 35 "$CONTAINER" >/dev/null 2>&1 && echo "stopped" || echo "not running"; docker rm "$CONTAINER" >/dev/null 2>&1 || true;;
    logs) exec docker logs -f --tail 100 "$CONTAINER";;
    status) docker ps -a --filter "name=^${CONTAINER}$" --format '{{.Names}}  {{.Status}}  {{.Image}}'; docker logs --tail 15 "$CONTAINER" 2>&1 || true;;
    key)
      mkdir -p "$SECRETS" && chmod 700 "$SECRETS"
      # Two key runs at once could each mint a key: one at a time.
      mkdir "$SECRETS/.key.lock" 2>/dev/null || { echo "another 'start.sh key' is running (if none is, remove $SECRETS/.key.lock)"; exit 1; }
      umask 077
      local rc=0
      make_key "${2:-}" || rc=$?
      rmdir "$SECRETS/.key.lock"
      exit "$rc";;
    start) start_worker;;
    *) echo "usage: $0 [start|stop|logs|status|key [--replace]]"; exit 2;;
  esac
}

# Sourcing defines the functions only (the tests do that); running it runs main.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
