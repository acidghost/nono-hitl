package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/acidghost/nono-hitl/internal/classifier"
)

const validEntry = `{"prefix":["docker"],"ask":"Is this docker command risky?","model":"d3","max_risk":0.3,"mode":"advise"}`

func TestLoadReadsConfig(t *testing.T) {
	t.Parallel()

	path := writeConfig(t, `{
		"ollama_url": "http://127.0.0.1:9999",
		"classifiers": [`+validEntry+`]
	}`)
	config, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	want := File{
		OllamaURL: "http://127.0.0.1:9999",
		Classifiers: []classifier.Entry{{
			Prefix:  []string{"docker"},
			Ask:     "Is this docker command risky?",
			Model:   "d3",
			MaxRisk: 0.3,
			Mode:    classifier.ModeAdvise,
		}},
	}
	if !reflect.DeepEqual(config, want) {
		t.Fatalf("Load() = %+v, want %+v", config, want)
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Parallel()

	missing, err := Load(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatalf("Load() of a missing file error = %v", err)
	}
	if missing.OllamaURL != DefaultOllamaURL || len(missing.Classifiers) != 0 {
		t.Fatalf("Load() of a missing file = %+v, want the default URL and no classifiers", missing)
	}

	noURL, err := Load(writeConfig(t, `{"classifiers":[`+validEntry+`]}`))
	if err != nil {
		t.Fatalf("Load() without ollama_url error = %v", err)
	}
	if noURL.OllamaURL != DefaultOllamaURL {
		t.Fatalf("OllamaURL = %q, want %q", noURL.OllamaURL, DefaultOllamaURL)
	}
}

func TestLoadRejectsInvalidConfigs(t *testing.T) {
	t.Parallel()

	entry := func(replace ...string) string {
		return `{"classifiers":[` + strings.NewReplacer(replace...).Replace(validEntry) + `]}`
	}
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{name: "malformed", content: `{`, want: "decode"},
		{name: "trailing data", content: `{"classifiers":[]} {}`, want: "trailing data"},
		{name: "unknown field", content: entry(`"mode"`, `"moed"`), want: "unknown field"},
		{name: "ftp url", content: `{"ollama_url":"ftp://127.0.0.1"}`, want: "ollama_url"},
		{name: "url without host", content: `{"ollama_url":"http://"}`, want: "ollama_url"},
		{name: "no prefix", content: entry(`["docker"]`, `[]`), want: "prefix must contain"},
		{
			name:    "long prefix",
			content: entry(`["docker"]`, `["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q"]`),
			want:    "prefix must contain",
		},
		{name: "empty token", content: entry(`["docker"]`, `["docker",""]`), want: "must not be empty"},
		{name: "blank ask", content: entry(`"Is this docker command risky?"`, `" "`), want: "ask must contain"},
		{
			name:    "long ask",
			content: entry(`Is this docker command risky?`, strings.Repeat("a", 4*1024+1)),
			want:    "ask must contain",
		},
		{name: "no model", content: entry(`"d3"`, `""`), want: "model is required"},
		{name: "negative max_risk", content: entry(`0.3`, `-0.1`), want: "max_risk"},
		{name: "max_risk above one", content: entry(`0.3`, `1.5`), want: "max_risk"},
		{name: "no mode", content: entry(`,"mode":"advise"`, ``), want: "mode must be"},
		{name: "unknown mode", content: entry(`"advise"`, `"deny"`), want: "mode must be"},
		{
			name:    "repeated prefix",
			content: `{"classifiers":[` + validEntry + `,` + validEntry + `]}`,
			want:    "classifiers[1]: prefix",
		},
		{
			name:    "too many entries",
			content: `{"classifiers":[` + strings.Repeat(validEntry+",", maxClassifiers) + validEntry + `]}`,
			want:    "at most",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := Load(writeConfig(t, test.content))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Load() error = %v, want one containing %q", err, test.want)
			}
		})
	}
}

func TestDefaultPathFollowsXDG(t *testing.T) {
	t.Setenv("HOME", "/home/agent")

	t.Setenv("XDG_CONFIG_HOME", "/config")
	if got := DefaultPath(); got != "/config/nono-hitl/config.json" {
		t.Errorf("DefaultPath() = %q, want /config/nono-hitl/config.json", got)
	}
	t.Setenv("XDG_CONFIG_HOME", "relative/config")
	if got := DefaultPath(); got != "/home/agent/.config/nono-hitl/config.json" {
		t.Errorf("DefaultPath() with relative XDG_CONFIG_HOME = %q, want home default", got)
	}
}

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
