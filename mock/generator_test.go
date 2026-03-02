package mock

import (
	"math/rand"
	"testing"
)

func TestPickWeightedEdgeIndexBiasesTowardHigherWeights(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	edges := []edge{
		{srcSvc: "heavy", weight: 24},
		{srcSvc: "medium", weight: 8},
		{srcSvc: "light", weight: 3},
	}
	total := 24 + 8 + 3

	counts := make([]int, len(edges))
	for i := 0; i < 12000; i++ {
		idx := pickWeightedEdgeIndex(rng, edges, total)
		counts[idx]++
	}

	if counts[0] <= counts[1] {
		t.Fatalf("expected heavy edge to be selected most often, got heavy=%d medium=%d", counts[0], counts[1])
	}
	if counts[1] <= counts[2] {
		t.Fatalf("expected medium edge to be selected more than light edge, got medium=%d light=%d", counts[1], counts[2])
	}
}

func TestEdgeBurstSizeWithinConfiguredBounds(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	e := edge{burstMin: 2, burstMax: 5}

	seen := map[int]bool{}
	for i := 0; i < 300; i++ {
		n := edgeBurstSize(rng, e)
		if n < 2 || n > 5 {
			t.Fatalf("expected burst between 2 and 5, got %d", n)
		}
		seen[n] = true
	}

	// Confirm the generator uses the full configured range.
	for expected := 2; expected <= 5; expected++ {
		if !seen[expected] {
			t.Fatalf("expected burst size %d to appear at least once", expected)
		}
	}
}
