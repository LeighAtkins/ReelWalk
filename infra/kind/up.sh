#!/usr/bin/env bash
# Builds the images, loads them into the local kind cluster and installs the
# Helm release. Safe to re-run: every step is idempotent.
#
#   infra/kind/up.sh            build with tag "dev"
#   infra/kind/up.sh v2         build with another tag (rolls the Deployments)
set -euo pipefail

cd "$(dirname "$0")/../.."

TAG="${1:-dev}"
CLUSTER=reelwalk
CONTEXT="kind-${CLUSTER}"
NAMESPACE=reelwalk

if ! kind get clusters | grep -qx "${CLUSTER}"; then
  kind create cluster --config infra/kind/cluster.yaml
fi

docker build -f apps/web/Dockerfile -t "reelwalk-web:${TAG}" .
docker build -f apps/worker/Dockerfile -t "reelwalk-worker:${TAG}" .

# kind nodes cannot see the host's Docker images; copy them in.
kind load docker-image "reelwalk-web:${TAG}" "reelwalk-worker:${TAG}" --name "${CLUSTER}"

kubectl --context "${CONTEXT}" create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl --context "${CONTEXT}" apply -f -

# Postgres, MinIO and ElasticMQ: local stand-ins for RDS, S3 and SQS.
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" apply -f infra/k8s/local/deps.yaml
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" rollout status statefulset/postgres --timeout=180s
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" rollout status deployment/minio deployment/elasticmq --timeout=180s

helm upgrade --install reelwalk infra/helm/reelwalk \
  --kube-context "${CONTEXT}" \
  --namespace "${NAMESPACE}" \
  -f infra/helm/reelwalk/values-kind.yaml \
  --set web.image.tag="${TAG}" \
  --set worker.image.tag="${TAG}" \
  --wait --timeout 5m

kubectl --context "${CONTEXT}" -n "${NAMESPACE}" get pods
echo
echo "ReelWalk is running at http://localhost:8081"
