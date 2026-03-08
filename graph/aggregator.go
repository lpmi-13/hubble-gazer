package graph

import (
	"sort"
	"sync"
	"time"

	flowpb "github.com/cilium/cilium/api/v1/flow"
)

type ViewMode string

const (
	ViewModeService ViewMode = "service"
	ViewModePod     ViewMode = "pod"
)

func ParseViewMode(value string) (ViewMode, bool) {
	switch ViewMode(value) {
	case ViewModeService:
		return ViewModeService, true
	case ViewModePod:
		return ViewModePod, true
	default:
		return ViewModeService, false
	}
}

type SnapshotOptions struct {
	Namespace   string
	ViewMode    ViewMode
	PodMaxNodes int
}

// Node represents a graph node (service or pod depending on view mode).
type Node struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Namespace string `json:"namespace"`
	K8sNode   string `json:"k8sNode,omitempty"`
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
	Nodes      []Node      `json:"nodes"`
	Links      []Link      `json:"links"`
	ViewMode   ViewMode    `json:"viewMode"`
	K8sNodes   []string    `json:"k8sNodes,omitempty"`
	Truncation *Truncation `json:"truncation,omitempty"`
}

type Truncation struct {
	Reason     string `json:"reason"`
	Limit      int    `json:"limit"`
	TotalNodes int    `json:"totalNodes"`
	ShownNodes int    `json:"shownNodes"`
}

type flowRecord struct {
	timestamp  time.Time
	srcNS      string
	dstNS      string
	srcService string
	dstService string
	srcPod     string
	dstPod     string
	nodeName   string
	direction  flowpb.TrafficDirection
	verdict    flowpb.Verdict
	protocol   string
}

// Aggregator collects flows and produces a service graph.
type Aggregator struct {
	mu       sync.RWMutex
	window   time.Duration
	flows    []flowRecord
	nsSet    map[string]struct{}
	nodeSet  map[string]struct{}
	maxFlows int
}

// NewAggregator creates a new flow aggregator with the given sliding window duration.
func NewAggregator(window time.Duration) *Aggregator {
	return &Aggregator{
		window:   window,
		nsSet:    make(map[string]struct{}),
		nodeSet:  make(map[string]struct{}),
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
	srcService := serviceLabel(src)
	dstService := serviceLabel(dst)
	srcPod := podLabel(src)
	dstPod := podLabel(dst)

	if srcService == "" || dstService == "" {
		return
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
		timestamp:  time.Now(),
		srcNS:      srcNS,
		dstNS:      dstNS,
		srcService: srcService,
		dstService: dstService,
		srcPod:     srcPod,
		dstPod:     dstPod,
		nodeName:   flow.GetNodeName(),
		direction:  flow.GetTrafficDirection(),
		verdict:    flow.GetVerdict(),
		protocol:   proto,
	}

	a.mu.Lock()
	a.flows = append(a.flows, record)
	if srcNS != "" {
		a.nsSet[srcNS] = struct{}{}
	}
	if dstNS != "" {
		a.nsSet[dstNS] = struct{}{}
	}
	if nodeName := flow.GetNodeName(); nodeName != "" {
		a.nodeSet[nodeName] = struct{}{}
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
	return a.SnapshotWithOptions(SnapshotOptions{
		Namespace: namespace,
		ViewMode:  ViewModeService,
	})
}

// SnapshotWithOptions returns the current graph for a given view mode.
func (a *Aggregator) SnapshotWithOptions(options SnapshotOptions) Graph {
	viewMode := options.ViewMode
	if viewMode != ViewModePod {
		viewMode = ViewModeService
	}

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
		if options.Namespace == "" || f.srcNS == options.Namespace || f.dstNS == options.Namespace {
			filtered = append(filtered, f)
		}
	}

	var observedNodes []string
	if viewMode == ViewModePod {
		observedNodes = make([]string, 0, len(a.nodeSet))
		for nodeName := range a.nodeSet {
			if nodeName == "" {
				continue
			}
			observedNodes = append(observedNodes, nodeName)
		}
		sort.Strings(observedNodes)
	}
	a.mu.Unlock()

	if len(filtered) == 0 {
		return Graph{
			Nodes:    []Node{},
			Links:    []Link{},
			ViewMode: viewMode,
			K8sNodes: observedNodes,
		}
	}

	windowSecs := a.window.Seconds()

	// Build nodes and links
	nodeMap := make(map[string]*Node)
	nodeTraffic := make(map[string]int)
	podNodeVotes := make(map[string]map[string]int)
	type edgeKey struct{ src, dst string }
	edgeMap := make(map[edgeKey]*struct {
		count     int
		forwarded int
		protocol  map[string]int
	})

	for _, f := range filtered {
		srcLabel, dstLabel := labelsForView(f, viewMode)
		if srcLabel == "" || dstLabel == "" {
			continue
		}

		srcID := qualifiedID(f.srcNS, srcLabel)
		dstID := qualifiedID(f.dstNS, dstLabel)

		if _, ok := nodeMap[srcID]; !ok {
			nodeMap[srcID] = &Node{ID: srcID, Label: srcLabel, Namespace: f.srcNS}
		}
		if _, ok := nodeMap[dstID]; !ok {
			nodeMap[dstID] = &Node{ID: dstID, Label: dstLabel, Namespace: f.dstNS}
		}

		if viewMode == ViewModePod {
			assignPodNodeVote(
				podNodeVotes,
				f.nodeName,
				f.direction,
				srcID,
				dstID,
				srcLabel,
				dstLabel,
			)
		}

		nodeMap[dstID].Traffic++
		nodeTraffic[srcID]++
		nodeTraffic[dstID]++

		key := edgeKey{srcID, dstID}
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

	graph := Graph{
		ViewMode: viewMode,
		K8sNodes: observedNodes,
	}

	if viewMode == ViewModePod && options.PodMaxNodes > 0 && len(nodeMap) > options.PodMaxNodes {
		allowed := topNodeIDsByTraffic(nodeMap, nodeTraffic, options.PodMaxNodes)
		totalNodes := len(nodeMap)

		for id := range nodeMap {
			if _, ok := allowed[id]; !ok {
				delete(nodeMap, id)
			}
		}
		for key := range edgeMap {
			if _, ok := allowed[key.src]; !ok {
				delete(edgeMap, key)
				continue
			}
			if _, ok := allowed[key.dst]; !ok {
				delete(edgeMap, key)
			}
		}

		graph.Truncation = &Truncation{
			Reason:     "top_pods_by_traffic",
			Limit:      options.PodMaxNodes,
			TotalNodes: totalNodes,
			ShownNodes: len(nodeMap),
		}
	}

	nodes := make([]Node, 0, len(nodeMap))
	for _, n := range nodeMap {
		if viewMode == ViewModePod {
			n.K8sNode = dominantNodeName(podNodeVotes[n.ID])
		}
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

	graph.Nodes = nodes
	graph.Links = links
	return graph
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

func labelsForView(f flowRecord, viewMode ViewMode) (string, string) {
	if viewMode == ViewModePod {
		return podLabelOrFallback(f.srcPod, f.srcService), podLabelOrFallback(f.dstPod, f.dstService)
	}
	return f.srcService, f.dstService
}

func podLabelOrFallback(pod, fallback string) string {
	if pod != "" {
		return pod
	}
	return fallback
}

func assignPodNodeVote(votes map[string]map[string]int, observerNode string, direction flowpb.TrafficDirection, srcID, dstID, srcLabel, dstLabel string) {
	if observerNode == "" {
		return
	}

	switch direction {
	case flowpb.TrafficDirection_EGRESS:
		if srcLabel != "world" {
			addPodNodeVote(votes, srcID, observerNode)
		}
	case flowpb.TrafficDirection_INGRESS:
		if dstLabel != "world" {
			addPodNodeVote(votes, dstID, observerNode)
		}
	default:
		// Unknown direction: keep a best-effort mapping by crediting both endpoints.
		if srcLabel != "world" {
			addPodNodeVote(votes, srcID, observerNode)
		}
		if dstLabel != "world" {
			addPodNodeVote(votes, dstID, observerNode)
		}
	}
}

func addPodNodeVote(votes map[string]map[string]int, podID, nodeName string) {
	if podID == "" || nodeName == "" {
		return
	}
	byNode, ok := votes[podID]
	if !ok {
		byNode = make(map[string]int)
		votes[podID] = byNode
	}
	byNode[nodeName]++
}

func dominantNodeName(votes map[string]int) string {
	if len(votes) == 0 {
		return ""
	}

	bestNode := ""
	bestCount := -1
	for node, count := range votes {
		if count > bestCount || (count == bestCount && (bestNode == "" || node < bestNode)) {
			bestNode = node
			bestCount = count
		}
	}
	return bestNode
}

func qualifiedID(namespace, label string) string {
	if namespace == "" {
		return label
	}
	return namespace + "/" + label
}

func topNodeIDsByTraffic(nodes map[string]*Node, traffic map[string]int, limit int) map[string]struct{} {
	type nodeRank struct {
		id      string
		traffic int
	}
	ranked := make([]nodeRank, 0, len(nodes))
	for id := range nodes {
		ranked = append(ranked, nodeRank{
			id:      id,
			traffic: traffic[id],
		})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].traffic == ranked[j].traffic {
			return ranked[i].id < ranked[j].id
		}
		return ranked[i].traffic > ranked[j].traffic
	})

	kept := make(map[string]struct{}, limit)
	for i := 0; i < len(ranked) && i < limit; i++ {
		kept[ranked[i].id] = struct{}{}
	}
	return kept
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

func podLabel(ep *flowpb.Endpoint) string {
	if name := ep.GetPodName(); name != "" {
		return name
	}
	if ep.GetIdentity() == 1 {
		return "world"
	}
	return ""
}
