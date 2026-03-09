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
	Namespace    string
	ViewMode     ViewMode
	TrafficLayer TrafficLayer
	PodMaxNodes  int
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
	L7          *L7Details     `json:"l7,omitempty"`
}

type L7Details struct {
	RequestCount  int          `json:"requestCount"`
	ResponseCount int          `json:"responseCount"`
	HTTP          *HTTPDetails `json:"http,omitempty"`
}

type HTTPDetails struct {
	StatusClassMix map[string]int `json:"statusClassMix,omitempty"`
	MethodMix      map[string]int `json:"methodMix,omitempty"`
	P50LatencyMs   float64        `json:"p50LatencyMs,omitempty"`
	P95LatencyMs   float64        `json:"p95LatencyMs,omitempty"`
}

// Graph is the serialized network graph sent to the frontend.
type Graph struct {
	Nodes        []Node       `json:"nodes"`
	Links        []Link       `json:"links"`
	ViewMode     ViewMode     `json:"viewMode"`
	TrafficLayer TrafficLayer `json:"trafficLayer"`
	K8sNodes     []string     `json:"k8sNodes,omitempty"`
	Truncation   *Truncation  `json:"truncation,omitempty"`
}

type Truncation struct {
	Reason     string `json:"reason"`
	Limit      int    `json:"limit"`
	TotalNodes int    `json:"totalNodes"`
	ShownNodes int    `json:"shownNodes"`
}

type flowRecord struct {
	timestamp       time.Time
	srcNS           string
	dstNS           string
	srcService      string
	dstService      string
	srcPod          string
	dstPod          string
	nodeName        string
	direction       flowpb.TrafficDirection
	verdict         flowpb.Verdict
	protocol        string
	flowType        flowpb.FlowType
	l7Type          flowpb.L7FlowType
	l7Proto         string
	httpMethod      string
	httpStatusCode  uint32
	httpStatusClass string
	httpURL         string
	latencyNs       uint64
}

type observedPod struct {
	ID        string
	Label     string
	Namespace string
	K8sNode   string
}

type edgeAccumulator struct {
	count         int
	forwarded     int
	protocol      map[string]int
	requestCount  int
	responseCount int
	httpResponses int
	http5xx       int
	httpStatus    map[string]int
	httpMethods   map[string]int
	responseLatNs []uint64
}

// Aggregator collects flows and produces a service graph.
type Aggregator struct {
	mu           sync.RWMutex
	window       time.Duration
	flows        []flowRecord
	nsSet        map[string]struct{}
	nodeSet      map[string]struct{}
	podCatalog   map[string]observedPod
	podNodeVotes map[string]map[string]int
	maxFlows     int
}

// NewAggregator creates a new flow aggregator with the given sliding window duration.
func NewAggregator(window time.Duration) *Aggregator {
	return &Aggregator{
		window:       window,
		nsSet:        make(map[string]struct{}),
		nodeSet:      make(map[string]struct{}),
		podCatalog:   make(map[string]observedPod),
		podNodeVotes: make(map[string]map[string]int),
		maxFlows:     100000,
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

	flowType := flow.GetType()
	l7Type := flowpb.L7FlowType_UNKNOWN_L7_TYPE
	l7Proto := ""
	httpMethod := ""
	httpStatusCode := uint32(0)
	httpStatusClass := ""
	httpURL := ""
	latencyNs := uint64(0)

	if l7 := flow.GetL7(); flowType == flowpb.FlowType_L7 && l7 != nil {
		l7Type = l7.GetType()
		latencyNs = l7.GetLatencyNs()
		switch {
		case l7.GetHttp() != nil:
			http := l7.GetHttp()
			l7Proto = "HTTP"
			httpMethod = http.GetMethod()
			httpStatusCode = http.GetCode()
			httpStatusClass = httpStatusClassForCode(httpStatusCode)
			httpURL = sanitizeHTTPURL(http.GetUrl())
		case l7.GetDns() != nil:
			l7Proto = "DNS"
		case l7.GetKafka() != nil:
			l7Proto = "Kafka"
		default:
			l7Proto = "unknown"
		}
	}

	record := flowRecord{
		timestamp:       time.Now(),
		srcNS:           srcNS,
		dstNS:           dstNS,
		srcService:      srcService,
		dstService:      dstService,
		srcPod:          srcPod,
		dstPod:          dstPod,
		nodeName:        flow.GetNodeName(),
		direction:       flow.GetTrafficDirection(),
		verdict:         flow.GetVerdict(),
		protocol:        proto,
		flowType:        flowType,
		l7Type:          l7Type,
		l7Proto:         l7Proto,
		httpMethod:      httpMethod,
		httpStatusCode:  httpStatusCode,
		httpStatusClass: httpStatusClass,
		httpURL:         httpURL,
		latencyNs:       latencyNs,
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
	a.observePod(srcNS, podLabelOrFallback(srcPod, srcService))
	a.observePod(dstNS, podLabelOrFallback(dstPod, dstService))
	a.observePodNodes(
		flow.GetNodeName(),
		flow.GetTrafficDirection(),
		qualifiedID(srcNS, podLabelOrFallback(srcPod, srcService)),
		qualifiedID(dstNS, podLabelOrFallback(dstPod, dstService)),
		podLabelOrFallback(srcPod, srcService),
		podLabelOrFallback(dstPod, dstService),
	)
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
		Namespace:    namespace,
		ViewMode:     ViewModeService,
		TrafficLayer: TrafficLayerL4,
	})
}

// SnapshotWithOptions returns the current graph for a given view mode.
func (a *Aggregator) SnapshotWithOptions(options SnapshotOptions) Graph {
	viewMode := options.ViewMode
	if viewMode != ViewModePod {
		viewMode = ViewModeService
	}
	trafficLayer := options.TrafficLayer
	if trafficLayer != TrafficLayerL7 {
		trafficLayer = TrafficLayerL4
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

	catalogPods := make([]observedPod, 0)
	if viewMode == ViewModePod && options.Namespace != "" {
		catalogPods = a.namespaceObservedPods(options.Namespace)
	}
	a.mu.Unlock()

	windowSecs := a.window.Seconds()
	if windowSecs <= 0 {
		windowSecs = 1
	}

	// Build nodes and links
	nodeMap := make(map[string]*Node)
	nodeTraffic := make(map[string]int)
	podNodeVotes := make(map[string]map[string]int)
	for _, pod := range catalogPods {
		nodeMap[pod.ID] = &Node{
			ID:        pod.ID,
			Label:     pod.Label,
			Namespace: pod.Namespace,
			K8sNode:   pod.K8sNode,
		}
	}

	type edgeKey struct{ src, dst string }
	edgeMap := make(map[edgeKey]*edgeAccumulator)

	for _, f := range filtered {
		if trafficLayer == TrafficLayerL7 && !hasValidL7Record(f) {
			continue
		}

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
			e = &edgeAccumulator{
				protocol:    make(map[string]int),
				httpStatus:  make(map[string]int),
				httpMethods: make(map[string]int),
			}
			edgeMap[key] = e
		}
		e.count++
		if f.verdict == flowpb.Verdict_FORWARDED {
			e.forwarded++
		}
		if trafficLayer == TrafficLayerL7 {
			e.protocol[f.l7Proto]++
			switch f.l7Type {
			case flowpb.L7FlowType_REQUEST:
				e.requestCount++
				if f.l7Proto == "HTTP" && f.httpMethod != "" {
					e.httpMethods[f.httpMethod]++
				}
			case flowpb.L7FlowType_RESPONSE:
				e.responseCount++
				if f.l7Proto == "HTTP" {
					if f.httpStatusClass != "" {
						e.httpStatus[f.httpStatusClass]++
					}
					if f.httpStatusCode > 0 {
						e.httpResponses++
						if f.httpStatusClass == "5xx" {
							e.http5xx++
						}
					}
					if f.latencyNs > 0 {
						e.responseLatNs = append(e.responseLatNs, f.latencyNs)
					}
				}
			}
			continue
		}
		e.protocol[f.protocol]++
	}

	graph := Graph{
		ViewMode:     viewMode,
		TrafficLayer: trafficLayer,
		K8sNodes:     observedNodes,
	}

	if viewMode == ViewModePod && options.PodMaxNodes > 0 && options.Namespace == "" && len(nodeMap) > options.PodMaxNodes {
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
			if nodeName := dominantNodeName(podNodeVotes[n.ID]); nodeName != "" {
				n.K8sNode = nodeName
			}
		}
		nodes = append(nodes, *n)
	}

	links := make([]Link, 0, len(edgeMap))
	for key, e := range edgeMap {
		dominantProto := dominantCountKey(e.protocol)
		successRate := successRateForEdge(trafficLayer, e)
		verdict := verdictForSuccessRate(successRate)

		link := Link{
			Source:      key.src,
			Target:      key.dst,
			FlowRate:    float64(e.count) / windowSecs,
			FlowCount:   e.count,
			SuccessRate: successRate,
			Protocol:    dominantProto,
			ProtocolMix: cloneProtocolCounts(e.protocol),
			Verdict:     verdict,
		}
		if trafficLayer == TrafficLayerL7 {
			link.L7 = l7DetailsForEdge(e)
		}
		links = append(links, link)
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

func hasValidL7Record(f flowRecord) bool {
	return f.flowType == flowpb.FlowType_L7 && f.l7Proto != ""
}

func httpStatusClassForCode(code uint32) string {
	switch {
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	case code >= 500 && code < 600:
		return "5xx"
	case code == 0:
		return ""
	default:
		return "other"
	}
}

func sanitizeHTTPURL(raw string) string {
	const maxLen = 160
	if len(raw) <= maxLen {
		return raw
	}
	return raw[:maxLen]
}

func dominantCountKey(counts map[string]int) string {
	bestKey := "unknown"
	bestCount := -1
	for key, count := range counts {
		if count > bestCount || (count == bestCount && key < bestKey) {
			bestKey = key
			bestCount = count
		}
	}
	return bestKey
}

func successRateForEdge(layer TrafficLayer, e *edgeAccumulator) float64 {
	if e == nil || e.count <= 0 {
		return 0
	}
	if layer == TrafficLayerL7 && e.httpResponses > 0 {
		return 1 - (float64(e.http5xx) / float64(e.httpResponses))
	}
	return float64(e.forwarded) / float64(e.count)
}

func verdictForSuccessRate(successRate float64) string {
	if successRate < 0.5 {
		return "DROPPED"
	}
	return "FORWARDED"
}

func l7DetailsForEdge(e *edgeAccumulator) *L7Details {
	if e == nil {
		return nil
	}

	details := &L7Details{
		RequestCount:  e.requestCount,
		ResponseCount: e.responseCount,
	}
	if e.httpResponses == 0 && len(e.httpStatus) == 0 && len(e.httpMethods) == 0 && len(e.responseLatNs) == 0 {
		return details
	}

	http := &HTTPDetails{
		StatusClassMix: cloneProtocolCounts(e.httpStatus),
		MethodMix:      topCountMap(e.httpMethods, 5),
	}
	if len(e.responseLatNs) > 0 {
		http.P50LatencyMs = percentileLatencyMs(e.responseLatNs, 0.50)
		http.P95LatencyMs = percentileLatencyMs(e.responseLatNs, 0.95)
	}
	details.HTTP = http
	return details
}

func topCountMap(counts map[string]int, limit int) map[string]int {
	if len(counts) == 0 || limit <= 0 {
		return nil
	}

	type entry struct {
		key   string
		count int
	}
	ranked := make([]entry, 0, len(counts))
	for key, count := range counts {
		if count <= 0 {
			continue
		}
		ranked = append(ranked, entry{key: key, count: count})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].count == ranked[j].count {
			return ranked[i].key < ranked[j].key
		}
		return ranked[i].count > ranked[j].count
	})

	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	result := make(map[string]int, len(ranked))
	for _, entry := range ranked {
		result[entry.key] = entry.count
	}
	return result
}

func percentileLatencyMs(values []uint64, percentile float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]uint64(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	if percentile <= 0 {
		return float64(sorted[0]) / float64(time.Millisecond)
	}
	if percentile >= 1 {
		return float64(sorted[len(sorted)-1]) / float64(time.Millisecond)
	}

	index := int(percentile * float64(len(sorted)))
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	return float64(sorted[index]) / float64(time.Millisecond)
}

func (a *Aggregator) observePod(namespace, label string) {
	if namespace == "" || label == "" || label == "world" {
		return
	}

	id := qualifiedID(namespace, label)
	if existing, ok := a.podCatalog[id]; ok {
		if existing.K8sNode == "" {
			existing.K8sNode = dominantNodeName(a.podNodeVotes[id])
			a.podCatalog[id] = existing
		}
		return
	}

	a.podCatalog[id] = observedPod{
		ID:        id,
		Label:     label,
		Namespace: namespace,
		K8sNode:   dominantNodeName(a.podNodeVotes[id]),
	}
}

func (a *Aggregator) observePodNodes(observerNode string, direction flowpb.TrafficDirection, srcID, dstID, srcLabel, dstLabel string) {
	assignPodNodeVote(a.podNodeVotes, observerNode, direction, srcID, dstID, srcLabel, dstLabel)
	for _, podID := range []string{srcID, dstID} {
		pod, ok := a.podCatalog[podID]
		if !ok {
			continue
		}
		if nodeName := dominantNodeName(a.podNodeVotes[podID]); nodeName != "" {
			pod.K8sNode = nodeName
			a.podCatalog[podID] = pod
		}
	}
}

func (a *Aggregator) namespaceObservedPods(namespace string) []observedPod {
	pods := make([]observedPod, 0)
	for _, pod := range a.podCatalog {
		if pod.Namespace != namespace {
			continue
		}
		pods = append(pods, pod)
	}
	sort.SliceStable(pods, func(i, j int) bool {
		return pods[i].ID < pods[j].ID
	})
	return pods
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
