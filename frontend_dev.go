//go:build dev

package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

func registerFrontendRoutes(mux *http.ServeMux) error {
	viteOrigin := envOr("VITE_DEV_ORIGIN", "http://localhost:5173")
	target, err := url.Parse(viteOrigin)
	if err != nil {
		return err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, proxyErr error) {
		http.Error(w, "frontend dev server unavailable", http.StatusBadGateway)
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r)
	})
	return nil
}
