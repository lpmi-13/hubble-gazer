package graph

import (
	"testing"
	"time"

	flowpb "github.com/cilium/cilium/api/v1/flow"
)

func TestParseTrafficLayer(t *testing.T) {
	layer, ok := ParseTrafficLayer("l4")
	if !ok || layer != TrafficLayerL4 {
		t.Fatalf("expected l4 to parse")
	}

	layer, ok = ParseTrafficLayer("l7")
	if !ok || layer != TrafficLayerL7 {
		t.Fatalf("expected l7 to parse")
	}

	layer, ok = ParseTrafficLayer("bogus")
	if ok || layer != TrafficLayerL4 {
		t.Fatalf("expected bogus layer to fail and fall back to l4, got %q ok=%v", layer, ok)
	}
}

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

func TestSnapshotWithOptionsPodViewIncludesK8sNode(t *testing.T) {
	aggregator := NewAggregator(30 * time.Second)

	aggregator.AddFlow(newFlowWithPodsOnNode(
		"demo", "frontend", "frontend-0",
		"demo", "api", "api-0",
		"node-a", flowpb.TrafficDirection_EGRESS,
		flowpb.Verdict_FORWARDED, "TCP",
	))
	aggregator.AddFlow(newFlowWithPodsOnNode(
		"demo", "frontend", "frontend-0",
		"demo", "api", "api-0",
		"node-a", flowpb.TrafficDirection_EGRESS,
		flowpb.Verdict_FORWARDED, "TCP",
	))
	aggregator.AddFlow(newFlowWithPodsOnNode(
		"demo", "frontend", "frontend-0",
		"demo", "api", "api-0",
		"node-b", flowpb.TrafficDirection_EGRESS,
		flowpb.Verdict_FORWARDED, "TCP",
	))
	aggregator.AddFlow(newFlowWithPodsOnNode(
		"demo", "frontend", "frontend-0",
		"demo", "api", "api-0",
		"node-c", flowpb.TrafficDirection_INGRESS,
		flowpb.Verdict_FORWARDED, "TCP",
	))

	snapshot := aggregator.SnapshotWithOptions(SnapshotOptions{
		ViewMode: ViewModePod,
	})

	byID := make(map[string]Node, len(snapshot.Nodes))
	for _, node := range snapshot.Nodes {
		byID[node.ID] = node
	}

	frontend, ok := byID["demo/frontend-0"]
	if !ok {
		t.Fatalf("expected frontend pod node to exist")
	}
	if frontend.K8sNode != "node-a" {
		t.Fatalf("expected frontend pod to map to node-a, got %q", frontend.K8sNode)
	}

	api, ok := byID["demo/api-0"]
	if !ok {
		t.Fatalf("expected api pod node to exist")
	}
	if api.K8sNode != "node-c" {
		t.Fatalf("expected api pod to map to node-c, got %q", api.K8sNode)
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

func TestSnapshotWithOptionsPodViewNamespaceFilterKeepsAllObservedK8sNodes(t *testing.T) {
	aggregator := NewAggregator(30 * time.Second)

	aggregator.AddFlow(newFlowWithPodsOnNode(
		"demo", "frontend", "frontend-0",
		"demo", "api", "api-0",
		"node-a", flowpb.TrafficDirection_EGRESS,
		flowpb.Verdict_FORWARDED, "TCP",
	))
	aggregator.AddFlow(newFlowWithPodsOnNode(
		"other", "frontend", "frontend-0",
		"other", "api", "api-0",
		"node-b", flowpb.TrafficDirection_EGRESS,
		flowpb.Verdict_FORWARDED, "TCP",
	))

	filtered := aggregator.SnapshotWithOptions(SnapshotOptions{
		Namespace: "demo",
		ViewMode:  ViewModePod,
	})
	if len(filtered.K8sNodes) != 2 {
		t.Fatalf("expected 2 observed k8s nodes, got %d", len(filtered.K8sNodes))
	}
	if filtered.K8sNodes[0] != "node-a" || filtered.K8sNodes[1] != "node-b" {
		t.Fatalf("unexpected k8s node list: %#v", filtered.K8sNodes)
	}

	emptyFiltered := aggregator.SnapshotWithOptions(SnapshotOptions{
		Namespace: "missing",
		ViewMode:  ViewModePod,
	})
	if len(emptyFiltered.Nodes) != 0 {
		t.Fatalf("expected 0 pod nodes for missing namespace, got %d", len(emptyFiltered.Nodes))
	}
	if len(emptyFiltered.K8sNodes) != 2 {
		t.Fatalf("expected observed k8s nodes to remain visible, got %d", len(emptyFiltered.K8sNodes))
	}
}

func TestSnapshotWithOptionsL7AggregatesHTTPDetails(t *testing.T) {
	aggregator := NewAggregator(30 * time.Second)

	aggregator.AddFlow(newHTTPFlow("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.L7FlowType_REQUEST, "GET", 0, 0))
	aggregator.AddFlow(newHTTPFlow("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.L7FlowType_REQUEST, "GET", 0, 0))
	aggregator.AddFlow(newHTTPFlow("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.L7FlowType_REQUEST, "POST", 0, 0))
	aggregator.AddFlow(newHTTPFlow("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.L7FlowType_RESPONSE, "GET", 200, 10*time.Millisecond))
	aggregator.AddFlow(newHTTPFlow("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.L7FlowType_RESPONSE, "GET", 404, 20*time.Millisecond))
	aggregator.AddFlow(newHTTPFlow("demo", "frontend", "frontend-0", "demo", "api", "api-0", flowpb.L7FlowType_RESPONSE, "POST", 503, 90*time.Millisecond))
	aggregator.AddFlow(newFlow("demo", "frontend", "demo", "db", flowpb.Verdict_FORWARDED, "TCP"))

	snapshot := aggregator.SnapshotWithOptions(SnapshotOptions{
		Namespace:    "demo",
		ViewMode:     ViewModeService,
		TrafficLayer: TrafficLayerL7,
	})

	if snapshot.TrafficLayer != TrafficLayerL7 {
		t.Fatalf("expected traffic layer l7, got %q", snapshot.TrafficLayer)
	}
	if len(snapshot.Links) != 1 {
		t.Fatalf("expected 1 l7 link, got %d", len(snapshot.Links))
	}

	link := snapshot.Links[0]
	if link.Protocol != "HTTP" {
		t.Fatalf("expected dominant protocol HTTP, got %q", link.Protocol)
	}
	if link.FlowCount != 6 {
		t.Fatalf("expected 6 l7 events, got %d", link.FlowCount)
	}
	if link.L7 == nil || link.L7.HTTP == nil {
		t.Fatalf("expected l7 http details to be present")
	}
	if link.L7.RequestCount != 3 || link.L7.ResponseCount != 3 {
		t.Fatalf("unexpected request/response counts: %+v", link.L7)
	}
	if link.L7.HTTP.StatusClassMix["2xx"] != 1 || link.L7.HTTP.StatusClassMix["4xx"] != 1 || link.L7.HTTP.StatusClassMix["5xx"] != 1 {
		t.Fatalf("unexpected status class mix: %#v", link.L7.HTTP.StatusClassMix)
	}
	if link.L7.HTTP.MethodMix["GET"] != 2 || link.L7.HTTP.MethodMix["POST"] != 1 {
		t.Fatalf("unexpected method mix: %#v", link.L7.HTTP.MethodMix)
	}
	if link.SuccessRate >= 0.67 || link.SuccessRate <= 0.65 {
		t.Fatalf("expected http success rate near 2/3, got %f", link.SuccessRate)
	}
	if link.L7.HTTP.P50LatencyMs <= 0 || link.L7.HTTP.P95LatencyMs < link.L7.HTTP.P50LatencyMs {
		t.Fatalf("unexpected latency percentiles: p50=%f p95=%f", link.L7.HTTP.P50LatencyMs, link.L7.HTTP.P95LatencyMs)
	}
}

func TestSnapshotWithOptionsPodViewNamespaceFilterKeepsObservedPodsWithoutCurrentTrafficAcrossLayers(t *testing.T) {
	aggregator := NewAggregator(30 * time.Second)

	aggregator.AddFlow(newFlowWithPodsOnNode(
		"demo", "frontend", "frontend-0",
		"demo", "api", "api-0",
		"node-a", flowpb.TrafficDirection_EGRESS,
		flowpb.Verdict_FORWARDED, "TCP",
	))
	aggregator.AddFlow(newHTTPFlowWithNode(
		"demo", "frontend", "frontend-0",
		"demo", "api", "api-0",
		"node-a", flowpb.TrafficDirection_EGRESS,
		flowpb.L7FlowType_REQUEST, "GET", 0, 0,
	))

	aggregator.mu.Lock()
	for i := range aggregator.flows {
		aggregator.flows[i].timestamp = time.Now().Add(-2 * aggregator.window)
	}
	aggregator.mu.Unlock()

	l4Snapshot := aggregator.SnapshotWithOptions(SnapshotOptions{
		Namespace:    "demo",
		ViewMode:     ViewModePod,
		TrafficLayer: TrafficLayerL4,
		PodMaxNodes:  1,
	})
	if len(l4Snapshot.Nodes) != 2 {
		t.Fatalf("expected idle pods to remain visible in l4 pod view, got %d nodes", len(l4Snapshot.Nodes))
	}
	if l4Snapshot.Truncation != nil {
		t.Fatalf("did not expect truncation for namespace-filtered pod view")
	}

	l7Snapshot := aggregator.SnapshotWithOptions(SnapshotOptions{
		Namespace:    "demo",
		ViewMode:     ViewModePod,
		TrafficLayer: TrafficLayerL7,
		PodMaxNodes:  1,
	})
	if len(l7Snapshot.Nodes) != 2 {
		t.Fatalf("expected idle pods to remain visible in l7 pod view, got %d nodes", len(l7Snapshot.Nodes))
	}
	if len(l7Snapshot.Links) != 0 {
		t.Fatalf("expected no active l7 links after window expiry, got %d", len(l7Snapshot.Links))
	}
	if l7Snapshot.Truncation != nil {
		t.Fatalf("did not expect truncation for namespace-filtered l7 pod view")
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
	return newFlowWithPodsOnNode(
		srcNS,
		srcApp,
		srcPod,
		dstNS,
		dstApp,
		dstPod,
		"",
		flowpb.TrafficDirection_TRAFFIC_DIRECTION_UNKNOWN,
		verdict,
		protocol,
	)
}

func newFlowWithPodsOnNode(srcNS, srcApp, srcPod, dstNS, dstApp, dstPod, nodeName string, direction flowpb.TrafficDirection, verdict flowpb.Verdict, protocol string) *flowpb.Flow {
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
		NodeName:         nodeName,
		TrafficDirection: direction,
		Verdict:          verdict,
		L4:               protocolLayer(protocol),
	}
}

func newHTTPFlow(srcNS, srcApp, srcPod, dstNS, dstApp, dstPod string, flowType flowpb.L7FlowType, method string, code uint32, latency time.Duration) *flowpb.Flow {
	return newHTTPFlowWithNode(
		srcNS,
		srcApp,
		srcPod,
		dstNS,
		dstApp,
		dstPod,
		"",
		flowpb.TrafficDirection_TRAFFIC_DIRECTION_UNKNOWN,
		flowType,
		method,
		code,
		latency,
	)
}

func newHTTPFlowWithNode(srcNS, srcApp, srcPod, dstNS, dstApp, dstPod, nodeName string, direction flowpb.TrafficDirection, flowType flowpb.L7FlowType, method string, code uint32, latency time.Duration) *flowpb.Flow {
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
		Type:             flowpb.FlowType_L7,
		NodeName:         nodeName,
		TrafficDirection: direction,
		Verdict:          flowpb.Verdict_FORWARDED,
		L4:               protocolLayer("TCP"),
		L7: &flowpb.Layer7{
			Type:      flowType,
			LatencyNs: uint64(latency),
			Record: &flowpb.Layer7_Http{
				Http: &flowpb.HTTP{
					Method:   method,
					Code:     code,
					Url:      "/api",
					Protocol: "HTTP/1.1",
				},
			},
		},
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
