#!/usr/bin/env bash
# Installs Argo CD into the local kind cluster and hands the release over to
# it. Run infra/kind/up.sh first so the cluster and the local
# Postgres/MinIO/ElasticMQ exist.
set -euo pipefail

cd "$(dirname "$0")/../.."

CONTEXT=kind-reelwalk
ARGOCD_VERSION=v3.5.3

kubectl --context "${CONTEXT}" create namespace argocd --dry-run=client -o yaml | kubectl --context "${CONTEXT}" apply -f -
# Server-side apply: the Argo CD CRDs are too large for client-side apply annotations.
kubectl --context "${CONTEXT}" -n argocd apply --server-side \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"
kubectl --context "${CONTEXT}" -n argocd rollout status deployment/argocd-server --timeout=300s

# The repository and its GHCR images are public, so Argo CD needs no credentials.
kubectl --context "${CONTEXT}" apply -f infra/argocd/application.yaml

cat <<'EOF'

Argo CD is installed and now owns the "reelwalk" release: it deploys whatever
infra/helm/reelwalk/values-gitops.yaml on main points at. Deploy by merging to
main, not with `helm upgrade`.

Watch a sync:

  kubectl --context kind-reelwalk -n argocd get application reelwalk -w

Open the UI:

  kubectl --context kind-reelwalk -n argocd port-forward svc/argocd-server 8443:443
  # https://localhost:8443, user "admin", password:
  kubectl --context kind-reelwalk -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath='{.data.password}' | base64 -d
EOF
