package graph

type TrafficLayer string

const (
	TrafficLayerL4 TrafficLayer = "l4"
	TrafficLayerL7 TrafficLayer = "l7"
)

func ParseTrafficLayer(value string) (TrafficLayer, bool) {
	switch TrafficLayer(value) {
	case TrafficLayerL4:
		return TrafficLayerL4, true
	case TrafficLayerL7:
		return TrafficLayerL7, true
	default:
		return TrafficLayerL4, false
	}
}
