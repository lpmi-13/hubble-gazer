package main

import (
	"testing"
	"time"
)

type staticReadinessSource struct {
	ready bool
}

func (s staticReadinessSource) Ready() bool {
	return s.ready
}

func TestReadinessStateWaitsForRelayMetadataAndWarmup(t *testing.T) {
	state := newReadinessState(10*time.Second, true, true)
	state.SetMetadataSource(staticReadinessSource{ready: true})

	base := time.Date(2026, time.March, 17, 12, 0, 0, 0, time.UTC)
	state.startedAt = base
	state.now = func() time.Time { return base.Add(5 * time.Second) }
	state.SetRelayConnected(true)

	ready, reason := state.Ready()
	if ready {
		t.Fatalf("expected readiness to wait for warmup")
	}
	if reason == "" {
		t.Fatalf("expected warmup reason")
	}

	state.now = func() time.Time { return base.Add(11 * time.Second) }
	ready, reason = state.Ready()
	if !ready {
		t.Fatalf("expected readiness after warmup, got false: %s", reason)
	}
}

func TestReadinessStateRequiresRelayWhenConfigured(t *testing.T) {
	state := newReadinessState(0, true, false)

	ready, reason := state.Ready()
	if ready {
		t.Fatalf("expected readiness to fail without relay")
	}
	if reason != "waiting for hubble relay connection" {
		t.Fatalf("unexpected reason %q", reason)
	}
}

func TestReadinessStateRequiresMetadataWhenConfigured(t *testing.T) {
	state := newReadinessState(0, false, true)

	ready, reason := state.Ready()
	if ready {
		t.Fatalf("expected readiness to fail without metadata source")
	}
	if reason != "waiting for kubernetes pod metadata source" {
		t.Fatalf("unexpected reason %q", reason)
	}

	state.SetMetadataSource(staticReadinessSource{ready: false})
	ready, reason = state.Ready()
	if ready {
		t.Fatalf("expected readiness to fail with unsynced metadata source")
	}
	if reason != "waiting for kubernetes pod metadata sync" {
		t.Fatalf("unexpected reason %q", reason)
	}
}
