package graph

import (
	"testing"
	"time"

	flowpb "github.com/cilium/cilium/api/v1/flow"
)

func TestSnapshotIncludesProtocolMixAndDominantProtocol(t *testing.T) {
	aggregator := NewAggregator(30 * time.Second)

	aggregator.AddFlow(newFlow("demo", "frontend", "demo", "api", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlow("demo", "frontend", "demo", "api", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlow("demo", "frontend", "demo", "api", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlow("demo", "frontend", "demo", "api", flowpb.Verdict_FORWARDED, "UDP"))

	snapshot := aggregator.Snapshot("")
	if len(snapshot.Links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(snapshot.Links))
	}
	link := snapshot.Links[0]
	if link.Protocol != "TCP" {
		t.Fatalf("expected dominant protocol TCP, got %q", link.Protocol)
	}
	if link.ProtocolMix["TCP"] != 3 {
		t.Fatalf("expected TCP count 3, got %d", link.ProtocolMix["TCP"])
	}
	if link.ProtocolMix["UDP"] != 1 {
		t.Fatalf("expected UDP count 1, got %d", link.ProtocolMix["UDP"])
	}
	if len(link.ProtocolMix) != 2 {
		t.Fatalf("expected exactly 2 protocol entries, got %d", len(link.ProtocolMix))
	}
}

func TestSnapshotProtocolMixWorksWithNamespaceFilter(t *testing.T) {
	aggregator := NewAggregator(30 * time.Second)

	aggregator.AddFlow(newFlow("demo", "frontend", "demo", "api", flowpb.Verdict_FORWARDED, "UDP"))
	aggregator.AddFlow(newFlow("demo", "frontend", "demo", "api", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlow("other", "frontend", "other", "api", flowpb.Verdict_FORWARDED, "TCP"))

	snapshot := aggregator.Snapshot("demo")
	if len(snapshot.Links) != 1 {
		t.Fatalf("expected 1 link for demo namespace, got %d", len(snapshot.Links))
	}
	link := snapshot.Links[0]
	if link.FlowCount != 2 {
		t.Fatalf("expected flow count 2, got %d", link.FlowCount)
	}
	if link.ProtocolMix["UDP"] != 1 || link.ProtocolMix["TCP"] != 1 {
		t.Fatalf("unexpected protocol mix: %#v", link.ProtocolMix)
	}
}

func newFlow(srcNS, srcApp, dstNS, dstApp string, verdict flowpb.Verdict, protocol string) *flowpb.Flow {
	return &flowpb.Flow{
		Source: &flowpb.Endpoint{
			Namespace: srcNS,
			Labels:    []string{"app=" + srcApp},
		},
		Destination: &flowpb.Endpoint{
			Namespace: dstNS,
			Labels:    []string{"app=" + dstApp},
		},
		Verdict: verdict,
		L4:      protocolLayer(protocol),
	}
}

func protocolLayer(protocol string) *flowpb.Layer4 {
	switch protocol {
	case "TCP":
		return &flowpb.Layer4{
			Protocol: &flowpb.Layer4_TCP{
				TCP: &flowpb.TCP{},
			},
		}
	case "UDP":
		return &flowpb.Layer4{
			Protocol: &flowpb.Layer4_UDP{
				UDP: &flowpb.UDP{},
			},
		}
	case "ICMP":
		return &flowpb.Layer4{
			Protocol: &flowpb.Layer4_ICMPv4{
				ICMPv4: &flowpb.ICMPv4{},
			},
		}
	default:
		return nil
	}
}
