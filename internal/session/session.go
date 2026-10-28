// Package session reads the session records nono writes for each run, the
// same records "nono ps --json" prints.
package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
)

// StatusExited is the record status of a session whose command has ended.
const StatusExited = "exited"

const maxRecordBytes = 64 * 1024

var (
	ErrInvalidID     = errors.New("invalid nono session ID")
	ErrInvalidRecord = errors.New("invalid nono session record")

	// validID is nono's own rule for session IDs.
	validID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// Record is the part of a nono session record the dashboard shows.
type Record struct {
	Name    string   `json:"name,omitempty"`
	Command []string `json:"command,omitempty"`
	Profile string   `json:"profile,omitempty"`
	Workdir string   `json:"workdir,omitempty"`
	Started string   `json:"started,omitempty"`
	Status  string   `json:"status,omitempty"`
}

// Registry reads records from the sessions directory under nono's state
// directory.
type Registry struct {
	dir string
}

// NewRegistry reads records under stateDir, which must be absolute.
func NewRegistry(stateDir string) (*Registry, error) {
	if !filepath.IsAbs(stateDir) {
		return nil, fmt.Errorf("nono state directory must be absolute, got %q", stateDir)
	}
	return &Registry{dir: filepath.Join(stateDir, "sessions")}, nil
}

// DefaultStateDir resolves nono's state directory the way nono does:
// $XDG_STATE_HOME/nono when that is absolute, else ~/.local/state/nono.
func DefaultStateDir() string {
	if base := os.Getenv("XDG_STATE_HOME"); filepath.IsAbs(base) {
		return filepath.Join(base, "nono")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "state", "nono")
}

// Lookup reads the record of one session. Symlinks, non-regular files and
// records over 64 KiB are refused.
func (r *Registry) Lookup(id string) (*Record, error) {
	if !validID.MatchString(id) {
		return nil, fmt.Errorf("%w: %q", ErrInvalidID, id)
	}

	// validID keeps the path inside the sessions directory. O_NONBLOCK keeps a
	// FIFO planted in place of a record from blocking open.
	file, err := os.OpenFile( //nolint:gosec
		filepath.Join(r.dir, id+".json"),
		os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK,
		0,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: %s is not a regular file", ErrInvalidRecord, id)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxRecordBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxRecordBytes {
		return nil, fmt.Errorf("%w: %s exceeds %d bytes", ErrInvalidRecord, id, maxRecordBytes)
	}

	var record Record
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrInvalidRecord, id, err)
	}
	return &record, nil
}
