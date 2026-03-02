# Hubble Gazer

Realtime Kubernetes network traffic visualization for clusters running Cilium + Hubble.

## Demo

This is what runs locally when you run with `make dev` (it has sample data)

[demo.webm](https://github.com/user-attachments/assets/5cf1224a-2766-4d2d-95e4-ce224be5b655)

## What It Does
- Connects to Hubble Relay over gRPC (live mode)
- Generates synthetic flows for local development (mock mode)
- Aggregates flows into a rolling service graph
- Streams graph updates to browser clients via SSE
- Serves a React UI that visualizes live graph traffic

## Configuration
- `FLOW_SOURCE` (`hubble` or `mock`, default: `hubble`)
- `HUBBLE_RELAY_ADDR` (default: `hubble-relay.kube-system.svc.cluster.local:4245`)
- `LISTEN_ADDR` (default: `:3000`)

## Local Development

### Quickstart (single command with sample data)

```bash
make dev
```

This starts:
- backend on `http://localhost:3000` using built-in mock flow generation
- frontend on `http://localhost:5173` using Vite proxy to backend

Open `http://localhost:5173`.

### Live mode against Hubble Relay

```bash
HUBBLE_RELAY_ADDR=<relay-host:4245> make dev-live
```

### Additional commands

```bash
make test
make build-web
```

## Manual Development (without Make)

```bash
# terminal 1 (backend in dev mode; no web/dist required)
FLOW_SOURCE=mock LISTEN_ADDR=:3000 go run -tags dev .

# terminal 2 (frontend)
cd web
npm install
npm run dev
```

`go run .` (without `-tags dev`) builds the production server, which serves embedded static assets and expects files under `web/dist`.

## Container Build

```bash
docker build -t hubble-gazer .
docker run -p 3000:3000 -e HUBBLE_RELAY_ADDR=<relay-host:4245> hubble-gazer
```

## Release Artifacts

`./scripts/render-manifest.sh <image>` renders `deploy/kubernetes/hubble-gazer.yaml` from the template.

GitHub release workflow publishes:
- `ghcr.io/<owner>/hubble-gazer:<semver>`
- `ghcr.io/<owner>/hubble-gazer:sha-<sha>`
- `deploy/kubernetes/hubble-gazer.yaml` asset
