package main

import (
	"fmt"
	"sync/atomic"
	"time"
)

type readinessSource interface {
	Ready() bool
}

type readinessState struct {
	startedAt       time.Time
	now             func() time.Time
	warmup          time.Duration
	requireRelay    bool
	requireMetadata bool
	metadataSource  readinessSource
	relayConnected  atomic.Bool
}

func newReadinessState(warmup time.Duration, requireRelay, requireMetadata bool) *readinessState {
	if warmup < 0 {
		warmup = 0
	}

	return &readinessState{
		startedAt:       time.Now(),
		now:             time.Now,
		warmup:          warmup,
		requireRelay:    requireRelay,
		requireMetadata: requireMetadata,
	}
}

func (r *readinessState) SetMetadataSource(source readinessSource) {
	if r == nil {
		return
	}
	r.metadataSource = source
}

func (r *readinessState) SetRelayConnected(connected bool) {
	if r == nil {
		return
	}
	r.relayConnected.Store(connected)
}

func (r *readinessState) Ready() (bool, string) {
	if r == nil {
		return true, ""
	}

	if r.requireRelay && !r.relayConnected.Load() {
		return false, "waiting for hubble relay connection"
	}

	if r.requireMetadata {
		if r.metadataSource == nil {
			return false, "waiting for kubernetes pod metadata source"
		}
		if !r.metadataSource.Ready() {
			return false, "waiting for kubernetes pod metadata sync"
		}
	}

	if elapsed := r.now().Sub(r.startedAt); elapsed < r.warmup {
		return false, fmt.Sprintf("warming up (%s remaining)", (r.warmup - elapsed).Round(time.Second))
	}

	return true, ""
}
