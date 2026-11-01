#!/usr/bin/env bash
# Roll a commit of main out to production: wait for CI's images, point
# Terraform at them, check the plan does not change the worker's
# environment by accident, apply, and confirm App Runner serves it.
#
# Usage, from the checkout that holds infra/terraform/terraform.tfvars:
#   bash infra/deploy.sh            # the newest commit of main that CI built (not a bot release commit)
#   bash infra/deploy.sh <full sha> # a specific commit that CI has built
#
# ALLOW_WORKER_ENV_CHANGE=1 lets a plan through that changes the worker's
# environment variables (normally a sign that tfvars drifted from what
# was set by hand; see docs/postmortems/2026-10-19-maya-villa-reel.md).
set -euo pipefail
cd "$(dirname "$0")/.."

AWS=${AWS_CLI:-aws}; command -v "$AWS" >/dev/null || AWS="/c/Program Files/Amazon/AWSCLIV2/aws.exe"
TF=${TERRAFORM:-terraform}; command -v "$TF" >/dev/null || TF="/c/Users/Memory is RAM/AppData/Local/Microsoft/WinGet/Packages/Hashicorp.Terraform_Microsoft.Winget.Source_8wekyb3d8bbwe/terraform.exe"
export AWS_PROFILE=${AWS_PROFILE:-reelwalk} AWS_REGION=us-east-2 MSYS_NO_PATHCONV=1
REPO=LeighAtkins/ReelWalk
SERVICE_ARN=arn:aws:apprunner:us-east-2:734329326838:service/reelwalk-web/1a3d56a6e0874dcf9c1b871d937b2967
TFVARS=infra/terraform/terraform.tfvars
[ -f "$TFVARS" ] || { echo "no $TFVARS here; run from the ops checkout"; exit 1; }

# The newest commit on main that CI built: the bot's "release: deploy" commits only record an image tag (for Argo CD)
# and have no images of their own, so deploying one would wait for images that never come.
SHA=${1:-$(gh api "repos/$REPO/commits?sha=main&per_page=20" --jq '[.[] | select(.author.login != "github-actions[bot]" and (.commit.message | startswith("release: deploy") | not))][0].sha')}
OLD=$(sed -nE 's/^image_tag *= *"(.*)"/\1/p' "$TFVARS")
[ "$SHA" = "$OLD" ] && { echo "$SHA is already deployed"; exit 0; }
echo "[$(date +%T)] deploy ${SHA:0:7} (was ${OLD:0:7})"

# CI's merge build pushes both images for the commit; tags are immutable.
pushed() { "$AWS" ecr describe-images --repository-name "$1" --image-ids imageTag="$SHA" --query 'imageDetails[0].imagePushedAt' --output text 2>/dev/null; }
for i in $(seq 1 90); do
  if [ -n "$(pushed reelwalk-web)" ] && [ -n "$(pushed reelwalk-worker)" ]; then break; fi
  # Only the CI workflow builds images (Dependabot runs share the sha), and GitHub can take
  # several minutes to register the run after a merge, so wait up to 15 minutes for it.
  run=$(gh run list --repo "$REPO" --branch main --limit 20 --json headSha,status,conclusion,databaseId,workflowName --jq ".[] | select(.headSha==\"$SHA\" and .workflowName==\"CI\") | \"\(.status) \(.conclusion) \(.databaseId)\"" | head -1)
  case "$run" in
    "completed failure"*) echo "[$(date +%T)] main CI failed, re-running failed jobs"; gh run rerun "${run##* }" --repo "$REPO" --failed; sleep 60;;
    "") [ "$i" -gt 30 ] && { echo "no CI run for $SHA on main"; exit 1; };;
  esac
  [ "$i" = 90 ] && { echo "gave up waiting for images"; exit 1; }
  sleep 30
done
echo "[$(date +%T)] images ready"

sed -i -E "s/^image_tag *= *\".*\"/image_tag = \"$SHA\"/" "$TFVARS"
pushd infra/terraform >/dev/null
trap 'rm -f deploy.tfplan' EXIT
"$TF" plan -input=false -no-color -out=deploy.tfplan > plan.log 2>&1 || { grep -E "Error|error" plan.log | head; exit 1; }
grep -E "^Plan:|No changes" plan.log || true
# The worker task definition is replaced on every image change; its environment must not change with it.
diff=$("$TF" show -json deploy.tfplan | python -c '
import json, sys
for r in json.load(sys.stdin)["resource_changes"]:
    if r["address"] != "aws_ecs_task_definition.worker": continue
    old, new = r["change"].get("before") or {}, r["change"].get("after") or {}
    if not old.get("container_definitions") or not new.get("container_definitions"): continue
    before = {e["name"]: e["value"] for e in json.loads(old["container_definitions"])[0].get("environment", [])}
    after = {e["name"]: e["value"] for e in json.loads(new["container_definitions"])[0].get("environment", [])}
    print(" ".join(sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))))
')
if [ -n "$diff" ]; then
  echo "worker environment would change: $diff"
  [ "${ALLOW_WORKER_ENV_CHANGE:-}" = 1 ] || { echo "refusing; set ALLOW_WORKER_ENV_CHANGE=1 if that is intended"; sed -i -E "s/^image_tag *= *\".*\"/image_tag = \"$OLD\"/" "../../$TFVARS"; exit 1; }
fi
echo "[$(date +%T)] terraform apply"
"$TF" apply -input=false -no-color -auto-approve deploy.tfplan 2>&1 | grep -E "Apply complete|Error" || true
popd >/dev/null

for i in $(seq 1 40); do
  state=$("$AWS" apprunner describe-service --service-arn "$SERVICE_ARN" --query "Service.[Status,SourceConfiguration.ImageRepository.ImageIdentifier]" --output text)
  case "$state" in RUNNING*"$SHA"*) break;; esac
  sleep 20
done
echo "[$(date +%T)] App Runner ${state%%	*}, image ${state##*:}"
curl -s -o /dev/null -w "ready %{http_code}\n" https://reelwalking.com/api/ready || echo "ready check failed (curl $?)"
echo "tfvars now says image_tag = $SHA; commit it in the ops checkout if that is where it lives."
