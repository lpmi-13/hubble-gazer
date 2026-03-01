package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/iximiuz/hubble-gazer/graph"
	"github.com/iximiuz/hubble-gazer/hubble"
	"github.com/iximiuz/hubble-gazer/mock"
)

//go:embed web/dist/*
var frontendFS embed.FS

var validNamespace = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func main() {
	addr := envOr("LISTEN_ADDR", ":3000")
	relayAddr := envOr("HUBBLE_RELAY_ADDR", "hubble-relay.kube-system.svc.cluster.local:4245")
	flowSource := envOr("FLOW_SOURCE", "hubble")
	corsOrigin := os.Getenv("CORS_ALLOWED_ORIGIN")
	tlsCert := os.Getenv("TLS_CERT_FILE")
	tlsKey := os.Getenv("TLS_KEY_FILE")
	hubbleTLS := os.Getenv("HUBBLE_RELAY_TLS") == "true"

	aggregator := graph.NewAggregator(30 * time.Second)

	switch flowSource {
	case "mock":
		generator := mock.NewGenerator(42, aggregator)
		go generator.Run(context.Background())
		log.Printf("flow source: mock generator")
	case "hubble":
		client := hubble.NewClient(relayAddr, hubbleTLS, aggregator)
		go func() {
			for {
				log.Printf("connecting to Hubble Relay at %s", relayAddr)
				if err := client.Run(); err != nil {
					log.Printf("hubble client error: reconnecting in 5s")
				}
				time.Sleep(5 * time.Second)
			}
		}()
		log.Printf("flow source: hubble relay")
	default:
		log.Fatalf("invalid FLOW_SOURCE=%q (expected mock|hubble)", flowSource)
	}

	mux := http.NewServeMux()

	var activeSSE atomic.Int32
	const maxSSEConnections = 100

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /api/flows", func(w http.ResponseWriter, r *http.Request) {
		namespace := r.URL.Query().Get("namespace")
		if namespace != "" && !validNamespace.MatchString(namespace) {
			http.Error(w, "invalid namespace", http.StatusBadRequest)
			return
		}

		if activeSSE.Add(1) > maxSSEConnections {
			activeSSE.Add(-1)
			http.Error(w, "too many connections", http.StatusServiceUnavailable)
			return
		}
		defer activeSSE.Add(-1)

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

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
		namespaces := aggregator.Namespaces()
		if err := json.NewEncoder(w).Encode(namespaces); err != nil {
			log.Printf("failed to encode namespaces: %v", err)
		}
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

	limiter := newIPRateLimiter(60, 10)
	go limiter.cleanup(5 * time.Minute)

	handler := requestLogger(securityHeaders(corsMiddleware(corsOrigin)(rateLimitMiddleware(limiter)(mux))))

	log.Printf("starting server on %s", addr)
	if tlsCert != "" && tlsKey != "" {
		log.Printf("TLS enabled")
		log.Fatal(http.ListenAndServeTLS(addr, tlsCert, tlsKey, handler))
	} else {
		log.Fatal(http.ListenAndServe(addr, handler))
	}
}

func sendGraph(w http.ResponseWriter, flusher http.Flusher, agg *graph.Aggregator, namespace string) {
	g := agg.Snapshot(namespace)
	data, err := json.Marshal(g)
	if err != nil {
		log.Printf("failed to marshal graph: %v", err)
		return
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
		log.Printf("failed to write SSE event: %v", err)
		return
	}
	flusher.Flush()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// --- Middleware ---

// securityHeaders adds standard security headers to every response.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// corsMiddleware returns middleware that sets CORS headers if an origin is configured.
// With no origin configured, no CORS headers are sent (same-origin only).
func corsMiddleware(allowedOrigin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if allowedOrigin != "" {
				w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				if r.Method == http.MethodOptions {
					w.WriteHeader(http.StatusNoContent)
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// statusWriter wraps http.ResponseWriter to capture the status code.
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (sw *statusWriter) WriteHeader(code int) {
	if !sw.wrote {
		sw.status = code
		sw.wrote = true
	}
	sw.ResponseWriter.WriteHeader(code)
}

func (sw *statusWriter) Write(b []byte) (int, error) {
	if !sw.wrote {
		sw.status = http.StatusOK
		sw.wrote = true
	}
	return sw.ResponseWriter.Write(b)
}

// Flush delegates to the underlying ResponseWriter if it implements http.Flusher.
// This is critical for SSE streaming to work through the middleware chain.
func (sw *statusWriter) Flush() {
	if f, ok := sw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// requestLogger logs each HTTP request with method, path, status, and duration.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Millisecond))
	})
}

// --- Rate Limiter ---

type visitor struct {
	tokens   float64
	lastSeen time.Time
}

type ipRateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitor
	rate     float64 // tokens per second
	burst    float64 // max tokens
}

func newIPRateLimiter(rate, burst float64) *ipRateLimiter {
	return &ipRateLimiter{
		visitors: make(map[string]*visitor),
		rate:     rate,
		burst:    burst,
	}
}

func (l *ipRateLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	v, exists := l.visitors[ip]
	now := time.Now()

	if !exists {
		l.visitors[ip] = &visitor{tokens: l.burst - 1, lastSeen: now}
		return true
	}

	elapsed := now.Sub(v.lastSeen).Seconds()
	v.lastSeen = now
	v.tokens += elapsed * l.rate
	if v.tokens > l.burst {
		v.tokens = l.burst
	}

	if v.tokens < 1 {
		return false
	}
	v.tokens--
	return true
}

func (l *ipRateLimiter) cleanup(interval time.Duration) {
	for {
		time.Sleep(interval)
		l.mu.Lock()
		for ip, v := range l.visitors {
			if time.Since(v.lastSeen) > interval {
				delete(l.visitors, ip)
			}
		}
		l.mu.Unlock()
	}
}

func rateLimitMiddleware(limiter *ipRateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip, _, _ := net.SplitHostPort(r.RemoteAddr)
			if ip == "" {
				ip = r.RemoteAddr
			}
			if !limiter.allow(ip) {
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
