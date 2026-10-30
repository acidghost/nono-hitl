// Package config reads nono-hitl's config file.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"

	"github.com/acidghost/nono-hitl/internal/classifier"
)

const (
	DefaultOllamaURL = "http://127.0.0.1:11434"

	maxClassifiers = 64
)

// File is the content of the config file.
type File struct {
	OllamaURL   string             `json:"ollama_url,omitempty"`
	Classifiers []classifier.Entry `json:"classifiers"`
}

// DefaultPath is $XDG_CONFIG_HOME/nono-hitl/config.json when that is
// absolute, else ~/.config/nono-hitl/config.json.
func DefaultPath() string {
	if base := os.Getenv("XDG_CONFIG_HOME"); filepath.IsAbs(base) {
		return filepath.Join(base, "nono-hitl", "config.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "nono-hitl", "config.json")
}

// Load reads and validates the config file. A missing file is an empty
// config. Unknown fields are errors, so a typo can't disable a check.
func Load(path string) (File, error) {
	file := File{OllamaURL: DefaultOllamaURL}
	data, err := os.ReadFile(path) //nolint:gosec // the path is the user's own config
	if errors.Is(err, fs.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return File{}, err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return File{}, fmt.Errorf("decode %s: %w", path, err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return File{}, fmt.Errorf("decode %s: trailing data after the config object", path)
	}
	if file.OllamaURL == "" {
		file.OllamaURL = DefaultOllamaURL
	}
	if err := file.Validate(); err != nil {
		return File{}, fmt.Errorf("%s: %w", path, err)
	}
	return file, nil
}

// Save writes a temporary file next to the config and renames it over the
// config, so a crash leaves the old file or the new one, never half of each.
// A symlinked config keeps its link and gets a new target. The file is 0600
// and a missing directory is created 0700.
func Save(path string, file File) error {
	if path == "" {
		return errors.New("the config file has no path")
	}
	if target, err := filepath.EvalSymlinks(path); err == nil {
		path = target
	}
	var data bytes.Buffer
	encoder := json.NewEncoder(&data)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(file); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	temp, err := os.CreateTemp(dir, ".config-*.json")
	if err != nil {
		return err
	}
	_, err = temp.Write(data.Bytes())
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(temp.Name())
	}
	return err
}

// Validate checks the URL, every classifier, and that no two classifiers
// share a prefix.
func (f File) Validate() error {
	parsed, err := url.Parse(f.OllamaURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("ollama_url must be an http or https URL, got %q", f.OllamaURL)
	}
	if len(f.Classifiers) > maxClassifiers {
		return fmt.Errorf("at most %d classifiers are allowed", maxClassifiers)
	}
	seen := make(map[string]bool, len(f.Classifiers))
	for i, entry := range f.Classifiers {
		if err := entry.Validate(); err != nil {
			return fmt.Errorf("classifiers[%d]: %w", i, err)
		}
		key := fmt.Sprintf("%q", entry.Prefix)
		if seen[key] {
			return fmt.Errorf("classifiers[%d]: prefix %s repeats an earlier entry", i, key)
		}
		seen[key] = true
	}
	return nil
}
