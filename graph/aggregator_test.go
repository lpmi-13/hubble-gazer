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

func TestSnapshotWithOptionsPodViewUsesPodIdentity(t *testing.T) {
	aggregator := NewAggregator(30 * time.Second)

	aggregator.AddFlow(newFlowWithPods("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlowWithPods("demo", "frontend", "frontend-1", "demo", "api", "api-0", flowpb.Verdict_FORWARDED, "TCP"))

	snapshot := aggregator.SnapshotWithOptions(SnapshotOptions{
		ViewMode: ViewModePod,
	})

	if snapshot.ViewMode != ViewModePod {
		t.Fatalf("expected view mode pod, got %q", snapshot.ViewMode)
	}
	if len(snapshot.Nodes) != 3 {
		t.Fatalf("expected 3 pod nodes, got %d", len(snapshot.Nodes))
	}
	if len(snapshot.Links) != 2 {
		t.Fatalf("expected 2 pod links, got %d", len(snapshot.Links))
	}
}

func TestSnapshotWithOptionsPodViewAppliesTopNTruncation(t *testing.T) {
	aggregator := NewAggregator(30 * time.Second)

	aggregator.AddFlow(newFlowWithPods("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlowWithPods("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlowWithPods("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlowWithPods("demo", "frontend", "frontend-0", "demo", "api", "api-1", flowpb.Verdict_FORWARDED, "TCP"))
	aggregator.AddFlow(newFlowWithPods("demo", "frontend", "frontend-1", "demo", "api", "api-2", flowpb.Verdict_FORWARDED, "TCP"))

	snapshot := aggregator.SnapshotWithOptions(SnapshotOptions{
		ViewMode:    ViewModePod,
		PodMaxNodes: 2,
	})

	if snapshot.Truncation == nil {
		t.Fatalf("expected truncation metadata")
	}
	if snapshot.Truncation.Reason != "top_pods_by_traffic" {
		t.Fatalf("unexpected truncation reason %q", snapshot.Truncation.Reason)
	}
	if snapshot.Truncation.Limit != 2 {
		t.Fatalf("expected limit 2, got %d", snapshot.Truncation.Limit)
	}
	if snapshot.Truncation.TotalNodes != 5 {
		t.Fatalf("expected total nodes 5, got %d", snapshot.Truncation.TotalNodes)
	}
	if snapshot.Truncation.ShownNodes != 2 {
		t.Fatalf("expected shown nodes 2, got %d", snapshot.Truncation.ShownNodes)
	}
	if len(snapshot.Nodes) != 2 {
		t.Fatalf("expected 2 nodes after truncation, got %d", len(snapshot.Nodes))
	}
	kept := make(map[string]struct{}, len(snapshot.Nodes))
	for _, node := range snapshot.Nodes {
		kept[node.ID] = struct{}{}
	}
	for _, link := range snapshot.Links {
		if _, ok := kept[link.Source]; !ok {
			t.Fatalf("unexpected source after truncation: %s", link.Source)
		}
		if _, ok := kept[link.Target]; !ok {
			t.Fatalf("unexpected link after truncation: %s -> %s", link.Source, link.Target)
		}
	}
}

func newFlow(srcNS, srcApp, dstNS, dstApp string, verdict flowpb.Verdict, protocol string) *flowpb.Flow {
	return newFlowWithPods(
		srcNS,
		srcApp,
		srcApp+"-0",
		dstNS,
		dstApp,
		dstApp+"-0",
		verdict,
		protocol,
	)
}

func newFlowWithPods(srcNS, srcApp, srcPod, dstNS, dstApp, dstPod string, verdict flowpb.Verdict, protocol string) *flowpb.Flow {
	return &flowpb.Flow{
		Source: &flowpb.Endpoint{
			Namespace: srcNS,
			PodName:   srcPod,
			Labels:    []string{"app=" + srcApp},
		},
		Destination: &flowpb.Endpoint{
			Namespace: dstNS,
			PodName:   dstPod,
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
