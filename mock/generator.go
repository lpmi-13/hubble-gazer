package mock

import (
	"context"
	"fmt"
	"math/rand"
	"sort"
	"strconv"
	"time"

	flowpb "github.com/cilium/cilium/api/v1/flow"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// FlowConsumer receives generated mock flows.
type FlowConsumer interface {
	AddFlow(flow *flowpb.Flow)
}

type edge struct {
	srcNS      string
	srcSvc     string
	dstNS      string
	dstSvc     string
	proto      string
	dstPort    uint32
	dropChance float64
	weight     int
	burstMin   int
	burstMax   int
}

// Generator emits synthetic flows for local development.
type Generator struct {
	consumer      FlowConsumer
	rng           *rand.Rand
	edges         []edge
	totalW        int
	replicaCounts map[string]int
	replicaNodes  map[string]string
}

var mockNodePool = []string{"worker-a", "worker-b", "worker-c", "worker-d"}

func NewGenerator(seed int64, consumer FlowConsumer) *Generator {
	edges := []edge{
		// Heavy internal traffic.
		{srcNS: "demo", srcSvc: "productpage", dstNS: "demo", dstSvc: "reviews", proto: "TCP", dstPort: 9080, dropChance: 0.08, weight: 28, burstMin: 2, burstMax: 6},
		{srcNS: "default", srcSvc: "frontend", dstNS: "default", dstSvc: "api", proto: "TCP", dstPort: 8080, dropChance: 0.1, weight: 24, burstMin: 2, burstMax: 5},
		// Medium traffic.
		{srcNS: "demo", srcSvc: "productpage", dstNS: "demo", dstSvc: "details", proto: "TCP", dstPort: 9080, dropChance: 0.04, weight: 14, burstMin: 1, burstMax: 3},
		{srcNS: "demo", srcSvc: "reviews", dstNS: "demo", dstSvc: "ratings", proto: "TCP", dstPort: 9080, dropChance: 0.12, weight: 10, burstMin: 1, burstMax: 3},
		{srcNS: "default", srcSvc: "api", dstNS: "", dstSvc: "world", proto: "TCP", dstPort: 443, dropChance: 0.06, weight: 8, burstMin: 1, burstMax: 2},
		// Low but steady DNS.
		{srcNS: "demo", srcSvc: "productpage", dstNS: "kube-system", dstSvc: "kube-dns", proto: "UDP", dstPort: 53, dropChance: 0.02, weight: 6, burstMin: 1, burstMax: 2},
	}

	totalWeight := 0
	for _, e := range edges {
		if e.weight <= 0 {
			totalWeight++
			continue
		}
		totalWeight += e.weight
	}

	rng := rand.New(rand.NewSource(seed))
	replicaCounts := buildReplicaCounts(rng, edges)
	replicaNodes := buildReplicaNodeAssignments(rng, replicaCounts)

	return &Generator{
		consumer:      consumer,
		rng:           rng,
		edges:         edges,
		totalW:        totalWeight,
		replicaCounts: replicaCounts,
		replicaNodes:  replicaNodes,
	}
}

func (g *Generator) Run(ctx context.Context) {
	counter := 0
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		e := g.pickEdge()
		burst := edgeBurstSize(g.rng, e)
		for i := 0; i < burst; i++ {
			verdict := flowpb.Verdict_FORWARDED
			if g.rng.Float64() < e.dropChance {
				verdict = flowpb.Verdict_DROPPED
			}
			g.consumer.AddFlow(g.makeFlow(e, verdict, counter))
			counter++
		}

		if counter%24 == 0 {
			// Periodic surges make a few paths visibly dominant in the UI.
			surge := g.pickEdge()
			if surge.weight < 20 {
				// Bias surges toward known heavy links.
				surge = g.edges[0]
			}
			surgeCount := 8 + g.rng.Intn(7)
			for i := 0; i < surgeCount; i++ {
				g.consumer.AddFlow(g.makeFlow(surge, flowpb.Verdict_FORWARDED, counter+i))
			}
		}

		sleep := time.Duration(90+g.rng.Intn(130)) * time.Millisecond
		timer := time.NewTimer(sleep)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (g *Generator) pickEdge() edge {
	if len(g.edges) == 0 {
		return edge{}
	}
	if len(g.edges) == 1 {
		return g.edges[0]
	}
	idx := pickWeightedEdgeIndex(g.rng, g.edges, g.totalW)
	return g.edges[idx]
}

func pickWeightedEdgeIndex(rng *rand.Rand, edges []edge, totalWeight int) int {
	if len(edges) == 0 {
		return 0
	}
	if totalWeight <= 0 {
		return rng.Intn(len(edges))
	}

	n := rng.Intn(totalWeight)
	running := 0
	for i, e := range edges {
		w := e.weight
		if w <= 0 {
			w = 1
		}
		running += w
		if n < running {
			return i
		}
	}
	return len(edges) - 1
}

func edgeBurstSize(rng *rand.Rand, e edge) int {
	minBurst := e.burstMin
	maxBurst := e.burstMax
	if minBurst <= 0 {
		minBurst = 1
	}
	if maxBurst < minBurst {
		maxBurst = minBurst
	}
	if maxBurst == minBurst {
		return minBurst
	}
	return minBurst + rng.Intn((maxBurst-minBurst)+1)
}

func (g *Generator) makeFlow(e edge, verdict flowpb.Verdict, seq int) *flowpb.Flow {
	srcIdx := g.randomReplicaIndex(e.srcNS, e.srcSvc)
	dstIdx := g.randomReplicaIndex(e.dstNS, e.dstSvc)
	src := endpoint(e.srcNS, e.srcSvc, srcIdx)
	dst := endpoint(e.dstNS, e.dstSvc, dstIdx)
	if e.dstSvc == "world" {
		dst = &flowpb.Endpoint{Identity: 1}
	}

	observerNode, direction := g.observerNodeAndDirection(e.srcNS, e.srcSvc, srcIdx, e.dstNS, e.dstSvc, dstIdx)

	l4 := &flowpb.Layer4{Protocol: &flowpb.Layer4_TCP{TCP: &flowpb.TCP{SourcePort: randomSrcPort(g.rng), DestinationPort: e.dstPort}}}
	if e.proto == "UDP" {
		l4 = &flowpb.Layer4{Protocol: &flowpb.Layer4_UDP{UDP: &flowpb.UDP{SourcePort: randomSrcPort(g.rng), DestinationPort: e.dstPort}}}
	}

	return &flowpb.Flow{
		Time:             timestamppb.Now(),
		Uuid:             fmt.Sprintf("mock-%d-%d", time.Now().UnixNano(), seq),
		Verdict:          verdict,
		Source:           src,
		Destination:      dst,
		NodeName:         observerNode,
		TrafficDirection: direction,
		L4:               l4,
	}
}

func endpoint(namespace, service string, idx int) *flowpb.Endpoint {
	if namespace == "kube-system" && service == "kube-dns" {
		return &flowpb.Endpoint{
			Namespace: namespace,
			PodName:   fmt.Sprintf("%s-%d", service, idx),
			Labels:    []string{"k8s-app=kube-dns"},
		}
	}
	return &flowpb.Endpoint{
		Namespace: namespace,
		PodName:   fmt.Sprintf("%s-%d", service, idx),
		Labels:    []string{"app=" + service},
	}
}

func buildReplicaCounts(rng *rand.Rand, edges []edge) map[string]int {
	counts := make(map[string]int)
	for _, e := range edges {
		assignReplicaCount(counts, rng, e.srcNS, e.srcSvc)
		assignReplicaCount(counts, rng, e.dstNS, e.dstSvc)
	}
	return counts
}

func assignReplicaCount(counts map[string]int, rng *rand.Rand, namespace, service string) {
	if service == "" || service == "world" {
		return
	}
	key := replicaKey(namespace, service)
	if _, exists := counts[key]; exists {
		return
	}
	counts[key] = 1 + rng.Intn(4)
}

func replicaKey(namespace, service string) string {
	if namespace == "" {
		return service
	}
	return namespace + "/" + service
}

func replicaInstanceKey(namespace, service string, idx int) string {
	return replicaKey(namespace, service) + "#" + strconv.Itoa(idx)
}

func buildReplicaNodeAssignments(rng *rand.Rand, replicaCounts map[string]int) map[string]string {
	assignments := make(map[string]string)
	keys := make([]string, 0, len(replicaCounts))
	for key := range replicaCounts {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		count := replicaCounts[key]
		if count <= 0 {
			continue
		}
		for idx := 0; idx < count; idx++ {
			instance := key + "#" + strconv.Itoa(idx)
			assignments[instance] = mockNodePool[rng.Intn(len(mockNodePool))]
		}
	}
	return assignments
}

func (g *Generator) randomReplicaIndex(namespace, service string) int {
	count := g.replicaCounts[replicaKey(namespace, service)]
	if count <= 1 {
		return 0
	}
	return g.rng.Intn(count)
}

func (g *Generator) observerNodeAndDirection(srcNS, srcSvc string, srcIdx int, dstNS, dstSvc string, dstIdx int) (string, flowpb.TrafficDirection) {
	srcNode := g.replicaNodes[replicaInstanceKey(srcNS, srcSvc, srcIdx)]
	dstNode := g.replicaNodes[replicaInstanceKey(dstNS, dstSvc, dstIdx)]

	if srcNode == "" && dstNode == "" {
		return "", flowpb.TrafficDirection_TRAFFIC_DIRECTION_UNKNOWN
	}
	if srcNode == "" {
		return dstNode, flowpb.TrafficDirection_INGRESS
	}
	if dstNode == "" {
		return srcNode, flowpb.TrafficDirection_EGRESS
	}
	if g.rng.Float64() < 0.35 {
		return dstNode, flowpb.TrafficDirection_INGRESS
	}
	return srcNode, flowpb.TrafficDirection_EGRESS
}

func randomSrcPort(rng *rand.Rand) uint32 {
	return uint32(30000 + rng.Intn(20000))
}
