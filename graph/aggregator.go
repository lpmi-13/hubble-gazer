package graph

import (
	"sync"
	"time"

	flowpb "github.com/cilium/cilium/api/v1/flow"
)

// Node represents a service in the graph.
type Node struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Namespace string `json:"namespace"`
	Traffic   int    `json:"traffic"` // total incoming flow count
}

// Link represents a connection between services.
type Link struct {
	Source      string         `json:"source"`
	Target      string         `json:"target"`
	FlowRate    float64        `json:"flowRate"`              // flows per second
	FlowCount   int            `json:"flowCount"`             // total flows in window
	SuccessRate float64        `json:"successRate"`           // fraction of FORWARDED flows
	Protocol    string         `json:"protocol"`              // dominant protocol
	ProtocolMix map[string]int `json:"protocolMix,omitempty"` // per-protocol flow counts
	Verdict     string         `json:"verdict"`               // dominant verdict
}

// Graph is the serialized network graph sent to the frontend.
type Graph struct {
	Nodes []Node `json:"nodes"`
	Links []Link `json:"links"`
}

type flowRecord struct {
	timestamp time.Time
	srcID     string
	dstID     string
	srcNS     string
	dstNS     string
	srcLabel  string
	dstLabel  string
	verdict   flowpb.Verdict
	protocol  string
}

// Aggregator collects flows and produces a service graph.
type Aggregator struct {
	mu       sync.RWMutex
	window   time.Duration
	flows    []flowRecord
	nsSet    map[string]struct{}
	maxFlows int
}

// NewAggregator creates a new flow aggregator with the given sliding window duration.
func NewAggregator(window time.Duration) *Aggregator {
	return &Aggregator{
		window:   window,
		nsSet:    make(map[string]struct{}),
		maxFlows: 100000,
	}
}

// AddFlow adds a Hubble flow to the aggregator.
func (a *Aggregator) AddFlow(flow *flowpb.Flow) {
	src := flow.GetSource()
	dst := flow.GetDestination()
	if src == nil || dst == nil {
		return
	}

	srcNS := src.GetNamespace()
	dstNS := dst.GetNamespace()
	srcLabel := serviceLabel(src)
	dstLabel := serviceLabel(dst)

	if srcLabel == "" || dstLabel == "" {
		return
	}

	srcID := srcNS + "/" + srcLabel
	dstID := dstNS + "/" + dstLabel
	if srcNS == "" {
		srcID = srcLabel
	}
	if dstNS == "" {
		dstID = dstLabel
	}

	proto := "unknown"
	if l4 := flow.GetL4(); l4 != nil {
		if l4.GetTCP() != nil {
			proto = "TCP"
		} else if l4.GetUDP() != nil {
			proto = "UDP"
		} else if l4.GetICMPv4() != nil || l4.GetICMPv6() != nil {
			proto = "ICMP"
		}
	}

	record := flowRecord{
		timestamp: time.Now(),
		srcID:     srcID,
		dstID:     dstID,
		srcNS:     srcNS,
		dstNS:     dstNS,
		srcLabel:  srcLabel,
		dstLabel:  dstLabel,
		verdict:   flow.GetVerdict(),
		protocol:  proto,
	}

	a.mu.Lock()
	a.flows = append(a.flows, record)
	if srcNS != "" {
		a.nsSet[srcNS] = struct{}{}
	}
	if dstNS != "" {
		a.nsSet[dstNS] = struct{}{}
	}
	// Evict oldest 10% when over capacity to avoid per-insert eviction overhead.
	if len(a.flows) > a.maxFlows {
		drop := a.maxFlows / 10
		a.flows = a.flows[drop:]
	}
	a.mu.Unlock()
}

// Namespaces returns all observed namespaces.
func (a *Aggregator) Namespaces() []string {
	a.mu.RLock()
	defer a.mu.RUnlock()

	ns := make([]string, 0, len(a.nsSet))
	for n := range a.nsSet {
		ns = append(ns, n)
	}
	return ns
}

// Snapshot returns the current service graph, optionally filtered by namespace.
func (a *Aggregator) Snapshot(namespace string) Graph {
	a.mu.Lock()
	cutoff := time.Now().Add(-a.window)
	// Prune old flows
	n := 0
	for _, f := range a.flows {
		if f.timestamp.After(cutoff) {
			a.flows[n] = f
			n++
		}
	}
	a.flows = a.flows[:n]

	// Copy relevant flows
	filtered := make([]flowRecord, 0, len(a.flows))
	for _, f := range a.flows {
		if namespace == "" || f.srcNS == namespace || f.dstNS == namespace {
			filtered = append(filtered, f)
		}
	}
	a.mu.Unlock()

	if len(filtered) == 0 {
		return Graph{Nodes: []Node{}, Links: []Link{}}
	}

	windowSecs := a.window.Seconds()

	// Build nodes and links
	nodeMap := make(map[string]*Node)
	type edgeKey struct{ src, dst string }
	edgeMap := make(map[edgeKey]*struct {
		count     int
		forwarded int
		protocol  map[string]int
	})

	for _, f := range filtered {
		if _, ok := nodeMap[f.srcID]; !ok {
			nodeMap[f.srcID] = &Node{ID: f.srcID, Label: f.srcLabel, Namespace: f.srcNS}
		}
		if _, ok := nodeMap[f.dstID]; !ok {
			nodeMap[f.dstID] = &Node{ID: f.dstID, Label: f.dstLabel, Namespace: f.dstNS}
		}
		nodeMap[f.dstID].Traffic++

		key := edgeKey{f.srcID, f.dstID}
		e, ok := edgeMap[key]
		if !ok {
			e = &struct {
				count     int
				forwarded int
				protocol  map[string]int
			}{protocol: make(map[string]int)}
			edgeMap[key] = e
		}
		e.count++
		if f.verdict == flowpb.Verdict_FORWARDED {
			e.forwarded++
		}
		e.protocol[f.protocol]++
	}

	nodes := make([]Node, 0, len(nodeMap))
	for _, n := range nodeMap {
		nodes = append(nodes, *n)
	}

	links := make([]Link, 0, len(edgeMap))
	for key, e := range edgeMap {
		// Find dominant protocol
		dominantProto := "unknown"
		maxCount := 0
		for proto, count := range e.protocol {
			if count > maxCount {
				dominantProto = proto
				maxCount = count
			}
		}

		verdict := "FORWARDED"
		successRate := float64(e.forwarded) / float64(e.count)
		if successRate < 0.5 {
			verdict = "DROPPED"
		}

		links = append(links, Link{
			Source:      key.src,
			Target:      key.dst,
			FlowRate:    float64(e.count) / windowSecs,
			FlowCount:   e.count,
			SuccessRate: successRate,
			Protocol:    dominantProto,
			ProtocolMix: cloneProtocolCounts(e.protocol),
			Verdict:     verdict,
		})
	}

	return Graph{Nodes: nodes, Links: links}
}

func cloneProtocolCounts(protocols map[string]int) map[string]int {
	if len(protocols) == 0 {
		return nil
	}
	copied := make(map[string]int, len(protocols))
	for protocol, count := range protocols {
		if count > 0 {
			copied[protocol] = count
		}
	}
	if len(copied) == 0 {
		return nil
	}
	return copied
}

// serviceLabel extracts a human-readable service name from a Hubble endpoint.
func serviceLabel(ep *flowpb.Endpoint) string {
	for _, lbl := range ep.GetLabels() {
		if len(lbl) > 4 && lbl[:4] == "app=" {
			return lbl[4:]
		}
	}
	for _, lbl := range ep.GetLabels() {
		if len(lbl) > 8 && lbl[:8] == "k8s-app=" {
			return lbl[8:]
		}
	}
	if name := ep.GetPodName(); name != "" {
		return name
	}
	if ep.GetIdentity() == 1 {
		return "world"
	}
	return ""
}
