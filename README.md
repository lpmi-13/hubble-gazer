# Hubble Gazer

Realtime Kubernetes network traffic visualization for clusters running Cilium + Hubble.

## What It Does
- Connects to Hubble Relay over gRPC
- Aggregates flows into a rolling service graph
- Streams graph updates to browser clients via SSE
- Serves a React UI that visualizes live graph traffic

## Configuration
- `HUBBLE_RELAY_ADDR` (default: `hubble-relay.kube-system.svc.cluster.local:4245`)
- `LISTEN_ADDR` (default: `:3000`)

## Local Development

```bash
# frontend
cd web
npm install
npm run build

# backend
cd ..
go test ./...
go run .
```

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
