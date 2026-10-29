//go:build dev

package webui

import "os"

// just dev serves from the repository root, so a browser refresh picks up bun's rebuilds.
func init() {
	files = os.DirFS("internal/webui")
}
