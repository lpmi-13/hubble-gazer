package mock

import (
	"math/rand"

	"github.com/iximiuz/hubble-gazer/graph"
)

type MetadataSource struct {
	pods map[string]graph.PodMetadata
}

func NewMetadataSource(seed int64) *MetadataSource {
	edges := defaultEdges()
	rng := rand.New(rand.NewSource(seed))
	replicaCounts := buildReplicaCounts(rng, edges)
	replicaNodes := buildReplicaNodeAssignments(rng, replicaCounts)
	pods := make(map[string]graph.PodMetadata, len(replicaNodes))

	for key, count := range replicaCounts {
		namespace, service := namespaceAndServiceForReplicaKey(key)
		for idx := 0; idx < count; idx++ {
			name := serviceReplicaName(service, idx)
			podKey := graphPodKey(namespace, name)
			pods[podKey] = graph.PodMetadata{
				NodeName: replicaNodes[replicaInstanceKey(namespace, service, idx)],
			}
		}
	}

	return &MetadataSource{pods: pods}
}

func (m *MetadataSource) Ready() bool {
	return m != nil
}

func (m *MetadataSource) LookupPod(namespace, name string) (graph.PodMetadata, bool) {
	if m == nil {
		return graph.PodMetadata{}, false
	}
	pod, ok := m.pods[graphPodKey(namespace, name)]
	return pod, ok
}

func graphPodKey(namespace, name string) string {
	if namespace == "" {
		return name
	}
	return namespace + "/" + name
}

func namespaceAndServiceForReplicaKey(key string) (string, string) {
	for i := 0; i < len(key); i++ {
		if key[i] != '/' {
			continue
		}
		return key[:i], key[i+1:]
	}
	return "", key
}

func serviceReplicaName(service string, idx int) string {
	return service + "-" + itoa(idx)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := [20]byte{}
	pos := len(digits)
	for value > 0 {
		pos--
		digits[pos] = byte('0' + (value % 10))
		value /= 10
	}
	return string(digits[pos:])
}
