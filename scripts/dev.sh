#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-mock}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "${ROOT_DIR}/web/node_modules" ]; then
  echo "[dev] installing frontend dependencies"
  (cd "${ROOT_DIR}/web" && npm install)
fi

if [ "${MODE}" = "hubble" ] && [ -z "${HUBBLE_RELAY_ADDR:-}" ]; then
  echo "[dev] warning: HUBBLE_RELAY_ADDR is not set; default will be used"
fi

echo "[dev] starting backend (FLOW_SOURCE=${MODE}) on http://localhost:3000"
(
  cd "${ROOT_DIR}"
  FLOW_SOURCE="${MODE}" LISTEN_ADDR="${LISTEN_ADDR:-:3000}" go run .
) &
BACKEND_PID=$!

echo "[dev] starting frontend on http://localhost:5173"
(
  cd "${ROOT_DIR}/web"
  npm run dev -- --host localhost
) &
FRONTEND_PID=$!

cleanup() {
  kill "${BACKEND_PID}" "${FRONTEND_PID}" >/dev/null 2>&1 || true
  wait "${BACKEND_PID}" >/dev/null 2>&1 || true
  wait "${FRONTEND_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait -n "${BACKEND_PID}" "${FRONTEND_PID}"
