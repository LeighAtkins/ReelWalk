#!/usr/bin/env bash
# metrics-server for the local kind cluster, so HorizontalPodAutoscalers can
# read CPU usage (`kubectl top` works too). kind's kubelets use self-signed
# certificates, hence --kubelet-insecure-tls; never use that flag elsewhere.
set -euo pipefail
CONTEXT="${CONTEXT:-kind-reelwalk}"
VERSION="${METRICS_SERVER_VERSION:-v0.8.1}"
kubectl --context "$CONTEXT" apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${VERSION}/components.yaml"
kubectl --context "$CONTEXT" -n kube-system patch deployment metrics-server --type json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl --context "$CONTEXT" -n kube-system rollout status deployment metrics-server --timeout=120s
