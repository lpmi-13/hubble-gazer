//go:build !dev

package main

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed web/dist/*
var frontendFS embed.FS

func registerFrontendRoutes(mux *http.ServeMux) error {
	distFS, err := fs.Sub(frontendFS, "web/dist")
	if err != nil {
		return err
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
	return nil
}
