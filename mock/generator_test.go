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

func TestBuildReplicaCountsWithinExpectedBounds(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	edges := []edge{
		{srcNS: "demo", srcSvc: "frontend", dstNS: "demo", dstSvc: "api"},
		{srcNS: "demo", srcSvc: "api", dstNS: "demo", dstSvc: "db"},
		{srcNS: "demo", srcSvc: "frontend", dstNS: "", dstSvc: "world"},
	}

	counts := buildReplicaCounts(rng, edges)
	if len(counts) != 3 {
		t.Fatalf("expected 3 replica count entries, got %d", len(counts))
	}

	for key, count := range counts {
		if count < 1 || count > 4 {
			t.Fatalf("expected replica count between 1 and 4 for %s, got %d", key, count)
		}
	}
}

func TestRandomReplicaIndexStaysWithinServiceReplicaCount(t *testing.T) {
	g := &Generator{
		rng: rand.New(rand.NewSource(3)),
		replicaCounts: map[string]int{
			replicaKey("demo", "frontend"): 3,
		},
	}

	seen := map[int]bool{}
	for i := 0; i < 300; i++ {
		idx := g.randomReplicaIndex("demo", "frontend")
		if idx < 0 || idx > 2 {
			t.Fatalf("expected index between 0 and 2, got %d", idx)
		}
		seen[idx] = true
	}

	if len(seen) < 2 {
		t.Fatalf("expected multiple replica indices to appear, got %v", seen)
	}
}

func TestBuildReplicaNodeAssignmentsCoversAllReplicaInstances(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	replicaCounts := map[string]int{
		replicaKey("demo", "frontend"): 2,
		replicaKey("demo", "api"):      1,
	}

	assignments := buildReplicaNodeAssignments(rng, replicaCounts)
	if len(assignments) != 3 {
		t.Fatalf("expected 3 replica-node assignments, got %d", len(assignments))
	}

	allowed := make(map[string]struct{}, len(mockNodePool))
	for _, node := range mockNodePool {
		allowed[node] = struct{}{}
	}

	expectedInstances := []string{
		replicaInstanceKey("demo", "frontend", 0),
		replicaInstanceKey("demo", "frontend", 1),
		replicaInstanceKey("demo", "api", 0),
	}
	for _, instance := range expectedInstances {
		node, ok := assignments[instance]
		if !ok {
			t.Fatalf("missing assignment for %s", instance)
		}
		if _, allowedNode := allowed[node]; !allowedNode {
			t.Fatalf("unexpected node assignment %q for %s", node, instance)
		}
	}
}
