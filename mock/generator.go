package mock

import (
	"context"
	"fmt"
	"math/rand"
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
}

// Generator emits synthetic flows for local development.
type Generator struct {
	consumer FlowConsumer
	rng      *rand.Rand
	edges    []edge
}

func NewGenerator(seed int64, consumer FlowConsumer) *Generator {
	return &Generator{
		consumer: consumer,
		rng:      rand.New(rand.NewSource(seed)),
		edges: []edge{
			{srcNS: "demo", srcSvc: "productpage", dstNS: "demo", dstSvc: "reviews", proto: "TCP", dstPort: 9080, dropChance: 0.08},
			{srcNS: "demo", srcSvc: "productpage", dstNS: "demo", dstSvc: "details", proto: "TCP", dstPort: 9080, dropChance: 0.04},
			{srcNS: "demo", srcSvc: "reviews", dstNS: "demo", dstSvc: "ratings", proto: "TCP", dstPort: 9080, dropChance: 0.12},
			{srcNS: "demo", srcSvc: "productpage", dstNS: "kube-system", dstSvc: "kube-dns", proto: "UDP", dstPort: 53, dropChance: 0.02},
			{srcNS: "default", srcSvc: "frontend", dstNS: "default", dstSvc: "api", proto: "TCP", dstPort: 8080, dropChance: 0.1},
			{srcNS: "default", srcSvc: "api", dstNS: "", dstSvc: "world", proto: "TCP", dstPort: 443, dropChance: 0.06},
		},
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

		e := g.edges[g.rng.Intn(len(g.edges))]
		verdict := flowpb.Verdict_FORWARDED
		if g.rng.Float64() < e.dropChance {
			verdict = flowpb.Verdict_DROPPED
		}

		g.consumer.AddFlow(g.makeFlow(e, verdict, counter))
		counter++

		if counter%24 == 0 {
			for i := 0; i < 8; i++ {
				burst := g.edges[g.rng.Intn(len(g.edges))]
				g.consumer.AddFlow(g.makeFlow(burst, flowpb.Verdict_FORWARDED, counter+i))
			}
		}

		sleep := time.Duration(150+g.rng.Intn(170)) * time.Millisecond
		timer := time.NewTimer(sleep)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (g *Generator) makeFlow(e edge, verdict flowpb.Verdict, seq int) *flowpb.Flow {
	src := endpoint(e.srcNS, e.srcSvc, g.rng.Intn(4))
	dst := endpoint(e.dstNS, e.dstSvc, g.rng.Intn(4))
	if e.dstSvc == "world" {
		dst = &flowpb.Endpoint{Identity: 1}
	}

	l4 := &flowpb.Layer4{Protocol: &flowpb.Layer4_TCP{TCP: &flowpb.TCP{SourcePort: randomSrcPort(g.rng), DestinationPort: e.dstPort}}}
	if e.proto == "UDP" {
		l4 = &flowpb.Layer4{Protocol: &flowpb.Layer4_UDP{UDP: &flowpb.UDP{SourcePort: randomSrcPort(g.rng), DestinationPort: e.dstPort}}}
	}

	return &flowpb.Flow{
		Time:        timestamppb.Now(),
		Uuid:        fmt.Sprintf("mock-%d-%d", time.Now().UnixNano(), seq),
		Verdict:     verdict,
		Source:      src,
		Destination: dst,
		L4:          l4,
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

func randomSrcPort(rng *rand.Rand) uint32 {
	return uint32(30000 + rng.Intn(20000))
}
