#!/usr/bin/env bash
# Installs Argo CD into the local kind cluster. Run infra/kind/up.sh first so
# the images and the local Postgres/MinIO/ElasticMQ exist.
set -euo pipefail

cd "$(dirname "$0")/../.."

CONTEXT=kind-reelwalk
ARGOCD_VERSION=v3.5.3

kubectl --context "${CONTEXT}" create namespace argocd --dry-run=client -o yaml | kubectl --context "${CONTEXT}" apply -f -
# Server-side apply: the Argo CD CRDs are too large for client-side apply annotations.
kubectl --context "${CONTEXT}" -n argocd apply --server-side \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"
kubectl --context "${CONTEXT}" -n argocd rollout status deployment/argocd-server --timeout=300s

cat <<'EOF'

Argo CD is installed. Next:

1. The repository is private, so give Argo CD read access (a fine-grained
   GitHub token with "Contents: read" on this repository is enough):

     kubectl --context kind-reelwalk -n argocd create secret generic reelwalk-repo \
       --from-literal=type=git \
       --from-literal=url=https://github.com/LeighAtkins/ReelWalk.git \
       --from-literal=username=git \
       --from-literal=password=<token>
     kubectl --context kind-reelwalk -n argocd label secret reelwalk-repo \
       argocd.argoproj.io/secret-type=repository

2. Hand the release over from Helm to Argo CD:

     kubectl --context kind-reelwalk apply -f infra/argocd/application.yaml

3. Open the UI:

     kubectl --context kind-reelwalk -n argocd port-forward svc/argocd-server 8443:443
     # https://localhost:8443, user "admin", password:
     kubectl --context kind-reelwalk -n argocd get secret argocd-initial-admin-secret \
       -o jsonpath='{.data.password}' | base64 -d
EOF
