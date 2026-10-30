package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/acidghost/nono-hitl/internal/classifier"
	"github.com/acidghost/nono-hitl/internal/config"
)

func TestConfigAPISavesClassifiersAndUsesThem(t *testing.T) {
	t.Parallel()

	service, store := newClassifiedServer(t, newFakeOllama(noul(0.1)))
	before := getConfig(t, service)
	if before.OllamaURL != fakeOllamaURL || len(before.Classifiers) != 0 {
		t.Fatalf("config before = %+v, want the fake URL and no classifiers", before)
	}

	body := classifiersBody(t, dockerEntry)
	response := putConfig(service, body, service.origin)
	if response.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	want := config.File{OllamaURL: fakeOllamaURL, Classifiers: []classifier.Entry{dockerEntry}}
	var saved config.File
	decodeResponse(t, response.Body, &saved)
	if !reflect.DeepEqual(saved, want) {
		t.Fatalf("PUT response = %+v, want %+v", saved, want)
	}
	if got := getConfig(t, service); !reflect.DeepEqual(got, want) {
		t.Fatalf("GET after PUT = %+v, want %+v", got, want)
	}

	onDisk, err := config.Load(service.config.ConfigPath)
	if err != nil {
		t.Fatalf("config.Load() error = %v", err)
	}
	if !reflect.DeepEqual(onDisk, want) {
		t.Fatalf("config file = %+v, want %+v", onDisk, want)
	}
	info, err := os.Stat(service.config.ConfigPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("Stat(config) = %v, %v, want mode 0600", info, err)
	}

	webhookDone := submitWebhook(service, webhookBody(t, "req-saved", "docker", "ps"))
	if advice := waitForAdvice(t, store, "req-saved"); advice.Ask != dockerEntry.Ask {
		t.Fatalf("advice = %+v, want the saved entry", advice)
	}
	performDecision(service, "req-saved", `{"decision":"denied"}`, service.origin)
	_ = awaitHTTPResponse(t, webhookDone)
}

func TestConfigAPIRejectsBadRequestsAndKeepsTheFile(t *testing.T) {
	t.Parallel()

	service, _ := newClassifiedServer(t, newFakeOllama(noul(0.1)))
	valid := classifiersBody(t, dockerEntry)
	if response := putConfig(service, valid, service.origin); response.Code != http.StatusOK {
		t.Fatalf("first PUT status = %d, want %d", response.Code, http.StatusOK)
	}
	saved, err := os.ReadFile(service.config.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}

	risky := dockerEntry
	risky.MaxRisk = 2
	tests := []struct {
		name        string
		body        string
		origin      string
		contentType string
		wantStatus  int
		wantError   string
	}{
		{name: "missing origin", body: valid, wantStatus: http.StatusForbidden},
		{name: "cross origin", body: valid, origin: "http://evil.test", wantStatus: http.StatusForbidden},
		{
			name:        "simple form",
			body:        valid,
			origin:      service.origin,
			contentType: "text/plain",
			wantStatus:  http.StatusUnsupportedMediaType,
		},
		{
			name:       "oversized",
			body:       strings.Repeat(" ", maxConfigBodyBytes) + valid,
			origin:     service.origin,
			wantStatus: http.StatusRequestEntityTooLarge,
		},
		{name: "malformed", body: `{`, origin: service.origin, wantStatus: http.StatusBadRequest},
		{
			name:       "ollama_url",
			body:       `{"ollama_url":"http://evil.test","classifiers":[]}`,
			origin:     service.origin,
			wantStatus: http.StatusBadRequest,
			wantError:  "invalid config request",
		},
		{
			name:       "no classifiers",
			body:       `{}`,
			origin:     service.origin,
			wantStatus: http.StatusBadRequest,
			wantError:  "classifiers is required",
		},
		{
			name:       "invalid entry",
			body:       classifiersBody(t, risky),
			origin:     service.origin,
			wantStatus: http.StatusBadRequest,
			wantError:  "classifiers[0]: max_risk",
		},
		{
			name:       "repeated prefix",
			body:       classifiersBody(t, dockerEntry, dockerEntry),
			origin:     service.origin,
			wantStatus: http.StatusBadRequest,
			wantError:  "classifiers[1]: prefix",
		},
	}
	for _, test := range tests {
		request := newRequest(http.MethodPut, "/api/v1/config", test.body)
		request.Header.Set("Origin", test.origin)
		request.Header.Set("Content-Type", "application/json")
		if test.contentType != "" {
			request.Header.Set("Content-Type", test.contentType)
		}
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, request)
		if response.Code != test.wantStatus || !strings.Contains(response.Body.String(), test.wantError) {
			t.Errorf("%s: response = %d %s, want %d with %q",
				test.name, response.Code, response.Body.String(), test.wantStatus, test.wantError)
		}
	}

	after, err := os.ReadFile(service.config.ConfigPath)
	if err != nil || string(after) != string(saved) {
		t.Fatalf("config file after bad requests = %s, %v, want it untouched", after, err)
	}
	if got := getConfig(t, service).Classifiers; !reflect.DeepEqual(got, []classifier.Entry{dockerEntry}) {
		t.Fatalf("classifiers after bad requests = %+v, want the docker entry", got)
	}
}

func TestConfigAPIKeepsTheOldEntriesWhenSavingFails(t *testing.T) {
	t.Parallel()

	ollama := newFakeOllama(noul(0.1))
	service, store := newClassifiedServer(t, ollama)
	// A regular file where the config directory should be.
	blocked := filepath.Join(t.TempDir(), "blocked")
	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	service.config.ConfigPath = filepath.Join(blocked, "config.json")

	response := putConfig(service, classifiersBody(t, dockerEntry), service.origin)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("PUT status = %d, want %d", response.Code, http.StatusInternalServerError)
	}
	if got := getConfig(t, service).Classifiers; len(got) != 0 {
		t.Fatalf("classifiers = %+v, want none", got)
	}
	webhookDone := submitWebhook(service, webhookBody(t, "req-unsaved", "docker", "ps"))
	waitForPending(t, store)
	performDecision(service, "req-unsaved", `{"decision":"denied"}`, service.origin)
	_ = awaitHTTPResponse(t, webhookDone)
	if got := len(ollama.requests()); got != 0 {
		t.Fatalf("Ollama calls = %d, want 0", got)
	}
}

func getConfig(t *testing.T, service *Server) config.File {
	t.Helper()
	response := performRequest(service, http.MethodGet, "/api/v1/config", "", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("GET config status = %d, want %d", response.Code, http.StatusOK)
	}
	var file config.File
	decodeResponse(t, response.Body, &file)
	return file
}

func putConfig(service *Server, body, origin string) *httptest.ResponseRecorder {
	return performRequest(service, http.MethodPut, "/api/v1/config", body, map[string]string{
		"Content-Type": "application/json",
		"Origin":       origin,
	})
}

func classifiersBody(t *testing.T, entries ...classifier.Entry) string {
	t.Helper()
	data, err := json.Marshal(configRequest{Classifiers: entries})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
