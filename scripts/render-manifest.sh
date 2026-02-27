#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-ghcr.io/iximiuz/hubble-gazer:latest}"
TEMPLATE="deploy/kubernetes/hubble-gazer.yaml.tmpl"
OUT="deploy/kubernetes/hubble-gazer.yaml"

sed "s|__IMAGE__|${IMAGE}|g" "${TEMPLATE}" > "${OUT}"
echo "rendered ${OUT} with image=${IMAGE}"
