#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-mock}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LISTEN_ADDR="${LISTEN_ADDR:-:3000}"
BACKEND_PORT="${LISTEN_ADDR##*:}"
FRONTEND_PORT="5173"

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :${port} )" 2>/dev/null | grep -q "LISTEN"
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

if [ ! -d "${ROOT_DIR}/web/node_modules" ]; then
  echo "[dev] installing frontend dependencies"
  (cd "${ROOT_DIR}/web" && npm install)
fi

if [ "${MODE}" = "hubble" ] && [ -z "${HUBBLE_RELAY_ADDR:-}" ]; then
  echo "[dev] warning: HUBBLE_RELAY_ADDR is not set; default will be used"
fi

if ! [[ "${BACKEND_PORT}" =~ ^[0-9]+$ ]]; then
  echo "[dev] error: couldn't parse backend port from LISTEN_ADDR='${LISTEN_ADDR}'"
  exit 1
fi

if port_in_use "${BACKEND_PORT}"; then
  echo "[dev] error: port ${BACKEND_PORT} is already in use"
  echo "[dev] hint: stop the existing process or run with a different LISTEN_ADDR"
  exit 1
fi

echo "[dev] starting backend (FLOW_SOURCE=${MODE}) on http://localhost:${BACKEND_PORT}"
(
  cd "${ROOT_DIR}"
  FLOW_SOURCE="${MODE}" LISTEN_ADDR="${LISTEN_ADDR}" CORS_ALLOWED_ORIGIN="http://localhost:${FRONTEND_PORT}" go run .
) &
BACKEND_PID=$!

cleanup() {
  kill "${BACKEND_PID}" >/dev/null 2>&1 || true
  if [ -n "${FRONTEND_PID:-}" ]; then
    kill "${FRONTEND_PID}" >/dev/null 2>&1 || true
  fi
  wait "${BACKEND_PID}" >/dev/null 2>&1 || true
  if [ -n "${FRONTEND_PID:-}" ]; then
    wait "${FRONTEND_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:${BACKEND_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${BACKEND_PID}" >/dev/null 2>&1; then
    echo "[dev] error: backend process exited before becoming ready"
    exit 1
  fi
  sleep 0.5
done

if ! curl -fsS "http://localhost:${BACKEND_PORT}/healthz" >/dev/null 2>&1; then
  echo "[dev] error: timed out waiting for backend readiness on port ${BACKEND_PORT}"
  exit 1
fi

echo "[dev] backend is ready"
echo "[dev] starting frontend on http://localhost:${FRONTEND_PORT}"
(
  cd "${ROOT_DIR}/web"
  npm run dev -- --host localhost
) &
FRONTEND_PID=$!

wait -n "${BACKEND_PID}" "${FRONTEND_PID}"
