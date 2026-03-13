package k8smeta

import (
	"context"
	"fmt"
	"os"
	"sync/atomic"

	corev1 "k8s.io/api/core/v1"
	informers "k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/iximiuz/hubble-gazer/graph"
)

type Resolver struct {
	factory     informers.SharedInformerFactory
	podInformer cache.SharedIndexInformer
	ready       atomic.Bool
}

func NewResolverFromEnvironment() (*Resolver, error) {
	config, err := clientcmd.BuildConfigFromFlags("", os.Getenv("KUBECONFIG"))
	if err != nil {
		return nil, fmt.Errorf("load kubernetes config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("build kubernetes client: %w", err)
	}

	return NewResolver(clientset), nil
}

func NewResolver(client kubernetes.Interface) *Resolver {
	factory := informers.NewSharedInformerFactory(client, 0)
	podInformer := factory.Core().V1().Pods().Informer()

	return &Resolver{
		factory:     factory,
		podInformer: podInformer,
	}
}

func (r *Resolver) Run(ctx context.Context) error {
	if r == nil {
		return nil
	}

	r.factory.Start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), r.podInformer.HasSynced) {
		if err := ctx.Err(); err != nil {
			return err
		}
		return fmt.Errorf("kubernetes pod metadata cache did not sync")
	}

	r.ready.Store(true)
	<-ctx.Done()
	return ctx.Err()
}

func (r *Resolver) Ready() bool {
	return r != nil && r.ready.Load()
}

func (r *Resolver) LookupPod(namespace, name string) (graph.PodMetadata, bool) {
	if r == nil || namespace == "" || name == "" || !r.ready.Load() {
		return graph.PodMetadata{}, false
	}

	key := namespace + "/" + name
	obj, exists, err := r.podInformer.GetStore().GetByKey(key)
	if err != nil || !exists {
		return graph.PodMetadata{}, false
	}

	pod, ok := obj.(*corev1.Pod)
	if !ok {
		return graph.PodMetadata{}, false
	}

	return graph.PodMetadata{
		UID:       string(pod.UID),
		NodeName:  pod.Spec.NodeName,
		CreatedAt: pod.CreationTimestamp.Time,
	}, true
}
