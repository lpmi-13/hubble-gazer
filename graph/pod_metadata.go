package graph

import "time"

type PodMetadata struct {
	UID       string
	NodeName  string
	CreatedAt time.Time
}

type PodMetadataSource interface {
	Ready() bool
	LookupPod(namespace, name string) (PodMetadata, bool)
}
