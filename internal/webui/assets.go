// Package webui embeds the local approval dashboard, bundled from src/ by bun into dist/.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
)

// Without a bun build, go build fails here on missing dist/ files, so no binary ships
// without its UI.
//
//go:embed index.html logo.svg dist/app.js dist/app.css dist/theme.js
var embedded embed.FS

var files fs.FS = embedded

// Handler serves the fixed set of dashboard assets.
func Handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/":
			serveAsset(writer, "text/html; charset=utf-8", "index.html")
		case "/assets/theme.js":
			serveAsset(writer, "text/javascript; charset=utf-8", "dist/theme.js")
		case "/assets/app.js":
			serveAsset(writer, "text/javascript; charset=utf-8", "dist/app.js")
		case "/assets/app.css":
			serveAsset(writer, "text/css; charset=utf-8", "dist/app.css")
		case "/assets/logo.svg":
			serveAsset(writer, "image/svg+xml", "logo.svg")
		default:
			http.NotFound(writer, request)
		}
	})
}

func serveAsset(writer http.ResponseWriter, contentType, name string) {
	content, err := fs.ReadFile(files, name)
	if err != nil {
		// Only the dev build reads from disk, where bun may be rewriting the file.
		http.Error(writer, err.Error(), http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(content)
}
