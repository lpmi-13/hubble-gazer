package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/iximiuz/hubble-gazer/graph"
	"github.com/iximiuz/hubble-gazer/hubble"
	"github.com/iximiuz/hubble-gazer/mock"
)

//go:embed web/dist/*
var frontendFS embed.FS

func main() {
	addr := envOr("LISTEN_ADDR", ":3000")
	relayAddr := envOr("HUBBLE_RELAY_ADDR", "hubble-relay.kube-system.svc.cluster.local:4245")
	flowSource := envOr("FLOW_SOURCE", "hubble")

	aggregator := graph.NewAggregator(30 * time.Second)

	switch flowSource {
	case "mock":
		generator := mock.NewGenerator(42, aggregator)
		go generator.Run(context.Background())
		log.Printf("flow source: mock generator")
	case "hubble":
		client := hubble.NewClient(relayAddr, aggregator)
		go func() {
			for {
				log.Printf("connecting to Hubble Relay at %s", relayAddr)
				if err := client.Run(); err != nil {
					log.Printf("hubble client error: %v; reconnecting in 5s", err)
				}
				time.Sleep(5 * time.Second)
			}
		}()
		log.Printf("flow source: hubble relay")
	default:
		log.Fatalf("invalid FLOW_SOURCE=%q (expected mock|hubble)", flowSource)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /api/flows", func(w http.ResponseWriter, r *http.Request) {
		namespace := r.URL.Query().Get("namespace")

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()

		sendGraph(w, flusher, aggregator, namespace)

		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				sendGraph(w, flusher, aggregator, namespace)
			}
		}
	})

	mux.HandleFunc("GET /api/namespaces", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		namespaces := aggregator.Namespaces()
		_ = json.NewEncoder(w).Encode(namespaces)
	})

	distFS, err := fs.Sub(frontendFS, "web/dist")
	if err != nil {
		log.Fatalf("failed to create sub filesystem: %v", err)
	}
	fileServer := http.FileServer(http.FS(distFS))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		f, err := distFS.Open(r.URL.Path[1:])
		if err != nil {
			r.URL.Path = "/"
		} else {
			_ = f.Close()
		}
		fileServer.ServeHTTP(w, r)
	})

	log.Printf("starting server on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func sendGraph(w http.ResponseWriter, flusher http.Flusher, agg *graph.Aggregator, namespace string) {
	g := agg.Snapshot(namespace)
	data, err := json.Marshal(g)
	if err != nil {
		log.Printf("failed to marshal graph: %v", err)
		return
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
	flusher.Flush()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
