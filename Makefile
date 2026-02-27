.PHONY: dev dev-live test build-web

dev:
	@./scripts/dev.sh mock

dev-live:
	@./scripts/dev.sh hubble

test:
	@go test ./...

build-web:
	@cd web && npm run build
