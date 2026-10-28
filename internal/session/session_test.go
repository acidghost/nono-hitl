package session

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestLookupReadsRecord(t *testing.T) {
	t.Parallel()

	registry, dir := newTestRegistry(t)
	writeRecord(t, dir, "a1b2c3", `{
		"session_id": "a1b2c3",
		"name": "review-bot",
		"supervisor_pid": 10,
		"child_pid": 11,
		"started": "2026-10-28T09:15:00+01:00",
		"status": "running",
		"command": ["claude", "--continue"],
		"profile": null,
		"workdir": "/work/nono-hitl",
		"network": "proxied"
	}`)

	record, err := registry.Lookup("a1b2c3")
	if err != nil {
		t.Fatalf("Lookup() error = %v", err)
	}
	want := Record{
		Name:    "review-bot",
		Command: []string{"claude", "--continue"},
		Workdir: "/work/nono-hitl",
		Started: "2026-10-28T09:15:00+01:00",
		Status:  "running",
	}
	if !reflect.DeepEqual(*record, want) {
		t.Fatalf("Lookup() = %+v, want %+v", *record, want)
	}
}

func TestLookupRefusesUnsafeRecords(t *testing.T) {
	t.Parallel()

	registry, dir := newTestRegistry(t)
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte(`{"status":"running"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "linked.json")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, "fifo.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "folder.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeRecord(t, dir, "large", `{"name":"`+strings.Repeat("x", maxRecordBytes)+`"}`)
	writeRecord(t, dir, "broken", `{"name":`)

	tests := []struct {
		id   string
		want error
	}{
		{id: "../outside", want: ErrInvalidID},
		{id: "", want: ErrInvalidID},
		{id: strings.Repeat("a", 65), want: ErrInvalidID},
		{id: "missing", want: fs.ErrNotExist},
		{id: "linked", want: syscall.ELOOP},
		{id: "fifo", want: ErrInvalidRecord},
		{id: "folder", want: ErrInvalidRecord},
		{id: "large", want: ErrInvalidRecord},
		{id: "broken", want: ErrInvalidRecord},
	}
	for _, test := range tests {
		record, err := registry.Lookup(test.id)
		if !errors.Is(err, test.want) || record != nil {
			t.Errorf("Lookup(%q) = %+v, %v; want error %v", test.id, record, err, test.want)
		}
	}
}

func TestNewRegistryRequiresAbsoluteStateDir(t *testing.T) {
	t.Parallel()

	for _, dir := range []string{"", "state/nono"} {
		if _, err := NewRegistry(dir); err == nil {
			t.Errorf("NewRegistry(%q) error = nil, want relative path error", dir)
		}
	}
}

func TestDefaultStateDirFollowsNono(t *testing.T) {
	t.Setenv("HOME", "/home/agent")

	t.Setenv("XDG_STATE_HOME", "/state")
	if got := DefaultStateDir(); got != "/state/nono" {
		t.Errorf("DefaultStateDir() = %q, want /state/nono", got)
	}
	t.Setenv("XDG_STATE_HOME", "relative/state")
	if got := DefaultStateDir(); got != "/home/agent/.local/state/nono" {
		t.Errorf("DefaultStateDir() with relative XDG_STATE_HOME = %q, want home default", got)
	}
}

func newTestRegistry(t *testing.T) (*Registry, string) {
	t.Helper()
	stateDir := t.TempDir()
	dir := filepath.Join(stateDir, "sessions")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	registry, err := NewRegistry(stateDir)
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	return registry, dir
}

func writeRecord(t *testing.T, dir, id, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
