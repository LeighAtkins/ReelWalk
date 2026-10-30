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
# Needs Docker Desktop and the AWS CLI with the `reelwalk` profile, which reads
# the deployed worker image, its settings and the database URL. Prints no
# secret. The worker's AWS key and the database URL are kept as files in
# ~/.reelwalk (outside every checkout) and mounted read-only into the
# container, so they are not in its environment for `docker inspect` to show.
set -euo pipefail
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1 # Git Bash would rewrite /reelwalk/DATABASE_URL into a Windows path

AWS=${AWS_CLI:-aws}; command -v "$AWS" >/dev/null || AWS="/c/Program Files/Amazon/AWSCLIV2/aws.exe"
PROFILE=${AWS_PROFILE_ADMIN:-reelwalk}
REGION=us-east-2
PROJECT=reelwalk
CONTAINER=reelwalk-local-worker-worker-local-1
SECRETS=${REELWALK_SECRETS:-$HOME/.reelwalk}
LOCK=${HEAVY_LOCK_PARENT:-C:/dev/lm}/.heavy.lock
aws_admin() { "$AWS" --profile "$PROFILE" --region "$REGION" "$@"; }

# These need no settings, so they work from a fresh shell.
case "${1:-start}" in
  stop) docker stop -t 35 "$CONTAINER" >/dev/null 2>&1 && echo "stopped" || echo "not running"; docker rm "$CONTAINER" >/dev/null 2>&1 || true; exit 0;;
  logs) exec docker logs -f --tail 100 "$CONTAINER";;
  status) docker ps -a --filter "name=^${CONTAINER}$" --format '{{.Names}}  {{.Status}}  {{.Image}}'; docker logs --tail 15 "$CONTAINER" 2>&1 || true; exit 0;;
  key)
    mkdir -p "$SECRETS" && chmod 700 "$SECRETS"
    [ -f "$SECRETS/aws-credentials" ] && { echo "$SECRETS/aws-credentials exists; delete it (and its key in IAM) first to make another"; exit 1; }
    umask 077
    aws_admin iam create-access-key --user-name "$PROJECT-local-worker" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text \
      | tr -d '\r' | awk '{ print "[default]\naws_access_key_id = " $1 "\naws_secret_access_key = " $2 }' > "$SECRETS/aws-credentials"
    grep -q '^aws_secret_access_key = .' "$SECRETS/aws-credentials" || { rm -f "$SECRETS/aws-credentials"; echo "could not create the key"; exit 1; }
    echo "wrote the reelwalk-local-worker key to $SECRETS/aws-credentials"; exit 0;;
  start) ;;
  *) echo "usage: $0 [start|stop|logs|status|key]"; exit 2;;
esac

docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop first"; exit 1; }
[ -f "$SECRETS/aws-credentials" ] || { echo "no worker key yet: run 'bash infra/local-worker/start.sh key' once"; exit 1; }
[ -d "${LOCK%/.heavy.lock}" ] || { echo "${LOCK%/.heavy.lock} does not exist: create it (mkdir -p /c/dev/lm) or set HEAVY_LOCK_PARENT"; exit 1; }

# The worker production runs right now: same image (so it matches the database schema) and same settings.
family="$PROJECT-worker"
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

# A heavy lock our worker left when its container went away (a crash, an OOM kill, a reboot, a recreate)
# would hold up every heavy job on this PC. Clear it, but only if owner.txt names our worker AND a
# container that is no longer running; anyone else's lock, or a live one, is never touched.
clear_dead_lock() {
  local holder host
  holder=$(cat "$LOCK/owner.txt" 2>/dev/null) || return 0
  case "$holder" in reelwalk-local-worker\ *) ;; *) return 0;; esac
  host=$(sed -nE 's/.* host=([^ ]+) .*/\1/p' <<<"$holder")
  [ -n "$host" ] || return 0
  if [ -n "$(docker ps -q --filter "id=$host" --filter status=running)" ]; then return 0; fi
  # Removed only if owner.txt still says the same, so nobody can have taken it in between.
  [ "$(cat "$LOCK/owner.txt" 2>/dev/null)" = "$holder" ] && rm -rf "$LOCK" && echo "removed a heavy lock left by a stopped worker container ($host)"
}
clear_dead_lock

echo "local worker up: ${REELWALK_WORKER_IMAGE##*:} on ${LOCAL_RENDER_QUEUE_URL##*/}"
echo "follow it with: bash infra/local-worker/start.sh logs"
