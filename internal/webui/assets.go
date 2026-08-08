// Package webui embeds the dependency-free local approval dashboard.
package webui

import (
	_ "embed"
	"net/http"
)

var (
	//go:embed index.html
	indexHTML []byte

	//go:embed app.js
	appJS []byte

	//go:embed style.css
	styleCSS []byte
)

// Handler serves the fixed set of embedded dashboard assets.
func Handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/":
			serveAsset(writer, "text/html; charset=utf-8", indexHTML)
		case "/assets/app.js":
			serveAsset(writer, "text/javascript; charset=utf-8", appJS)
		case "/assets/style.css":
			serveAsset(writer, "text/css; charset=utf-8", styleCSS)
		default:
			http.NotFound(writer, request)
		}
	})
}

func serveAsset(writer http.ResponseWriter, contentType string, content []byte) {
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(content)
}
