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
- Switches between `Network (L4)` and `Application (L7)` views without mixing transport and application semantics

## Configuration
- `FLOW_SOURCE` (`hubble` or `mock`, default: `hubble`)
- `HUBBLE_RELAY_ADDR` (default: `hubble-relay.kube-system.svc.cluster.local:4245`)
- `LISTEN_ADDR` (default: `:3000`)
- `READINESS_REQUIRE_HUBBLE_CONNECTED` (`true|false`, default: `true` in live mode)
- `READINESS_REQUIRE_POD_METADATA` (`true|false`, default: `false`)
- `READINESS_WARMUP_DURATION` (default: `10s`)

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

L7 mode depends on Cilium/Hubble exposing L7 flow data. When L7 visibility is not enabled, the UI stays functional but the `Application (L7)` view will be empty.

## API Notes

Health endpoints:
- `GET /healthz` reports process liveness
- `GET /readyz` reports traffic readiness for Kubernetes rollouts and ingress routing

`GET /api/flows` accepts:
- `view=service|pod`
- `namespace=<ns>`
- `layer=l4|l7` (defaults to `l4`)

When `namespace=<ns>` is set, the graph renders only nodes in that namespace. Cross-namespace peers are hidden, and links that depend on those hidden peers are omitted.
Pod view remains traffic-driven inside the active scope. Pods stay visible only while they still have flows inside the active window; terminated pods are shown with a distinct style until those flows expire.
When Hubble omits a pod name for an endpoint, the UI shows an explicit unresolved endpoint bucket instead of collapsing traffic onto the service name.
When Kubernetes pod metadata is available, grouped pod placement uses the Kubernetes API (`pod.spec.nodeName`). If that metadata is unavailable or still warming up, pod placement falls back to Hubble observer flows so `Pods by Node` can still render.

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
