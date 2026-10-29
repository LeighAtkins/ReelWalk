#!/usr/bin/env bash
# Runs production's render worker on this PC, for our own workspaces' renders
# (ADR 0094). One command, from any checkout of the repository, in Git Bash:
#
#   bash infra/local-worker/start.sh          # start (or update to the deployed image)
#   bash infra/local-worker/start.sh logs     # follow its log
#   bash infra/local-worker/start.sh status   # is it up, and what is it doing
#   bash infra/local-worker/start.sh stop     # stop it; queued renders fall back to Fargate after 10 min
#
# Needs Docker Desktop running, the AWS CLI with the `reelwalk` profile (it
# reads the deployed worker image, its settings and the database URL), and
# .env.aws (the reelwalk-app access key the worker runs as) at the root of the
# main checkout, or REELWALK_ENV_AWS=<path>. Prints no secret.
set -euo pipefail
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1 # Git Bash would rewrite /reelwalk/DATABASE_URL into a Windows path

AWS=${AWS_CLI:-aws}; command -v "$AWS" >/dev/null || AWS="/c/Program Files/Amazon/AWSCLIV2/aws.exe"
PROFILE=${AWS_PROFILE_ADMIN:-reelwalk}
REGION=us-east-2
PROJECT=reelwalk
aws_admin() { "$AWS" --profile "$PROFILE" --region "$REGION" "$@"; }
compose() { docker compose -f compose.yml "$@"; }

case "${1:-start}" in
  stop) compose down; exit 0;;
  logs) docker logs -f --tail 100 reelwalk-local-worker-worker-local-1; exit 0;;
  status) compose ps; docker logs --tail 15 reelwalk-local-worker-worker-local-1 2>&1 || true; exit 0;;
  start) ;;
  *) echo "usage: $0 [start|stop|logs|status]"; exit 2;;
esac

docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop first"; exit 1; }

# The runtime key, read without echoing. Several checkouts share this PC; .env.aws lives in the main one.
main_checkout=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
env_aws=${REELWALK_ENV_AWS:-}
for candidate in "$(git rev-parse --show-toplevel)/.env.aws" "$main_checkout/.env.aws"; do
  [ -z "$env_aws" ] && [ -f "$candidate" ] && env_aws=$candidate
done
[ -n "$env_aws" ] || { echo "no .env.aws found (set REELWALK_ENV_AWS=<path>)"; exit 1; }
read_env() { sed -nE "s/^$1=\"?([^\"]*)\"?\r?$/\1/p" "$env_aws" | tail -1; }
AWS_ACCESS_KEY_ID=$(read_env AWS_ACCESS_KEY_ID)
AWS_SECRET_ACCESS_KEY=$(read_env AWS_SECRET_ACCESS_KEY)
[ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] || { echo "$env_aws has no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY"; exit 1; }
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

# The worker production runs right now: same image (so it matches the database schema) and same settings.
family="$PROJECT-worker"
REELWALK_WORKER_IMAGE=$(aws_admin ecs describe-task-definition --task-definition "$family" --query 'taskDefinition.containerDefinitions[0].image' --output text)
aws_admin ecs describe-task-definition --task-definition "$family" \
  --query 'taskDefinition.containerDefinitions[0].environment[].[name,value]' --output text | tr -d '\r' | sed -E 's/\t/=/' > .env.task
grep -q '^LOCAL_RENDER_QUEUE_URL=' .env.task || {
  echo "the deployed worker ($REELWALK_WORKER_IMAGE) predates local rendering (ADR 0094); deploy it first"; exit 1; }
LOCAL_RENDER_QUEUE_URL=$(aws_admin sqs get-queue-url --queue-name "$PROJECT-render-jobs-local" --query QueueUrl --output text | tr -d '\r')
LOCAL_RENDER_DLQ_URL=$(aws_admin sqs get-queue-url --queue-name "$PROJECT-render-jobs-local-dlq" --query QueueUrl --output text | tr -d '\r')
DATABASE_URL=$(aws_admin ssm get-parameter --name "/$PROJECT/DATABASE_URL" --with-decryption --query Parameter.Value --output text | tr -d '\r')
[ -n "$DATABASE_URL" ] || { echo "could not read the database URL from SSM"; exit 1; }
export REELWALK_WORKER_IMAGE LOCAL_RENDER_QUEUE_URL LOCAL_RENDER_DLQ_URL DATABASE_URL

# The shared-PC heavy lock lives in C:\dev\lm (ADR 0094); the worker refuses to start without it.
lock_parent=${HEAVY_LOCK_PARENT:-C:/dev/lm}
[ -d "$lock_parent" ] || { echo "$lock_parent does not exist: create it (mkdir -p /c/dev/lm) or set HEAVY_LOCK_PARENT"; exit 1; }

if ! docker image inspect "$REELWALK_WORKER_IMAGE" >/dev/null 2>&1; then
  registry=${REELWALK_WORKER_IMAGE%%/*}
  aws_admin ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
  echo "pulling ${REELWALK_WORKER_IMAGE##*/}"
  docker pull -q "$REELWALK_WORKER_IMAGE" >/dev/null
fi

compose up -d --remove-orphans
echo "local worker up: ${REELWALK_WORKER_IMAGE##*:} on ${LOCAL_RENDER_QUEUE_URL##*/}"
echo "follow it with: bash infra/local-worker/start.sh logs"
