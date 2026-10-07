#!/usr/bin/env bash
# Deploys ReelWalk to the EKS cluster from infra/terraform. Safe to re-run.
#
#   infra/eks/deploy.sh            deploy the images named in values-gitops.yaml
#   infra/eks/deploy.sh <sha>      deploy a specific image tag
#
# Needs: aws (profile with cluster access), kubectl, helm, terraform, and the
# repo's .env for the Meta app credentials.
set -euo pipefail
cd "$(dirname "$0")/../.."

export AWS_PROFILE="${AWS_PROFILE:-reelwalk}"
REGION=us-east-2
NAMESPACE=reelwalk
TF=infra/terraform

CLUSTER=$(terraform -chdir="$TF" output -raw eks_cluster_name | tr -d '\r\n')
aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER" --alias "$CLUSTER" >/dev/null
KUBE=(--context "$CLUSTER")
HELM=(--kube-context "$CLUSTER")

TAG="${1:-$(grep -m1 'tag:' infra/helm/reelwalk/values-gitops.yaml | sed 's/.*"\(.*\)"/\1/')}"
echo "cluster: $CLUSTER   image tag: $TAG"

# ── Cluster add-ons: ingress-nginx behind an NLB, cert-manager ─────────────
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo update >/dev/null

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx "${HELM[@]}" \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-type"=nlb \
  --set controller.service.externalTrafficPolicy=Local \
  --set controller.config.use-forwarded-headers="true" \
  --wait --timeout 10m >/dev/null

helm upgrade --install cert-manager jetstack/cert-manager "${HELM[@]}" \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true \
  --wait --timeout 10m >/dev/null
kubectl "${KUBE[@]}" apply -f infra/eks/cluster-issuer.yaml

# ── The app ────────────────────────────────────────────────────────────────
kubectl "${KUBE[@]}" create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl "${KUBE[@]}" apply -f -

# Secrets: the database URL from Terraform, the Meta app from .env.
# RDS Postgres 16 requires TLS; the RDS CA is not in Node's trust store, so
# the connection is encrypted but the server certificate is not verified.
# tr strips the carriage return Terraform prints on Windows.
DATABASE_URL="$(terraform -chdir="$TF" output -raw database_url | tr -d '\r\n')?sslmode=no-verify"
env_value() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r\n' || true; }
kubectl "${KUBE[@]}" -n "$NAMESPACE" create secret generic reelwalk-secrets \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=META_APP_ID="$(env_value META_APP_ID)" \
  --from-literal=META_APP_SECRET="$(env_value META_APP_SECRET)" \
  --from-literal=META_LOGIN_CONFIG_ID="$(env_value META_LOGIN_CONFIG_ID)" \
  --from-literal=PIXABAY_API_KEY="$(env_value PIXABAY_API_KEY)" \
  --dry-run=client -o yaml | kubectl "${KUBE[@]}" apply -f -

# A failed migration Job is immutable; remove it so the release creates a fresh one.
kubectl "${KUBE[@]}" -n "$NAMESPACE" delete job -l app.kubernetes.io/component=migrate --ignore-not-found

helm upgrade --install reelwalk infra/helm/reelwalk "${HELM[@]}" \
  --namespace "$NAMESPACE" \
  -f infra/helm/reelwalk/values-aws.yaml \
  --set web.image.tag="$TAG" \
  --set worker.image.tag="$TAG"

# The Secret is managed outside the chart, so a changed value does not roll
# the pods by itself.
kubectl "${KUBE[@]}" -n "$NAMESPACE" rollout restart deployment/reelwalk-web deployment/reelwalk-worker
kubectl "${KUBE[@]}" -n "$NAMESPACE" wait --for=condition=complete job -l app.kubernetes.io/component=migrate --timeout=5m
kubectl "${KUBE[@]}" -n "$NAMESPACE" rollout status deployment/reelwalk-web --timeout=5m

echo
kubectl "${KUBE[@]}" -n "$NAMESPACE" get pods
echo
echo "Point the DNS record at this load balancer (CNAME, or Cloudflare flattened at the apex):"
kubectl "${KUBE[@]}" -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{"\n"}'
