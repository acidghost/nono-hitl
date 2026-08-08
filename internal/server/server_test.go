package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/acidghost/nono-hitl/internal/approval"
)

func TestNewRejectsNonLoopbackAddresses(t *testing.T) {
	t.Parallel()

	addresses := []string{
		"0.0.0.0:8765",
		"192.0.2.1:8765",
		"localhost:8765",
		"[::1]:8765",
		"127.0.0.1:0",
		"127.0.0.1",
	}
	for _, address := range addresses {
		t.Run(address, func(t *testing.T) {
			t.Parallel()
			store := newApprovalStore(t)
			config := DefaultConfig()
			config.ListenAddress = address
			if _, err := New(config, store); err == nil {
				t.Fatalf("New() error = nil for listen address %q", address)
			}
		})
	}
}

func TestHostAndSecurityHeaders(t *testing.T) {
	t.Parallel()

	service, _ := newTestServer(t, nil)

	badHost := httptest.NewRequest(http.MethodGet, "http://example.test/healthz", nil)
	badHost.Host = "example.test"
	badResponse := httptest.NewRecorder()
	service.Handler().ServeHTTP(badResponse, badHost)
	if badResponse.Code != http.StatusMisdirectedRequest {
		t.Fatalf("unexpected Host status = %d, want %d", badResponse.Code, http.StatusMisdirectedRequest)
	}

	response := performRequest(service, http.MethodGet, "/healthz", "", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("health status = %d, want %d", response.Code, http.StatusOK)
	}
	for _, header := range []string{
		"Content-Security-Policy",
		"Referrer-Policy",
		"X-Content-Type-Options",
		"X-Frame-Options",
	} {
		if response.Header().Get(header) == "" {
			t.Errorf("security header %s is missing", header)
		}
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty", got)
	}
}

func TestDashboardServesEmbeddedAssetsWithoutUnsafeRendering(t *testing.T) {
	t.Parallel()

	service, _ := newTestServer(t, nil)
	tests := []struct {
		path        string
		contentType string
		marker      string
	}{
		{path: "/", contentType: "text/html; charset=utf-8", marker: "Enable notifications"},
		{path: "/assets/app.js", contentType: "text/javascript; charset=utf-8", marker: "new EventSource"},
		{path: "/assets/style.css", contentType: "text/css; charset=utf-8", marker: ".button-deny"},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			t.Parallel()
			response := performRequest(service, http.MethodGet, test.path, "", nil)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
			}
			if got := response.Header().Get("Content-Type"); got != test.contentType {
				t.Fatalf("Content-Type = %q, want %q", got, test.contentType)
			}
			if !strings.Contains(response.Body.String(), test.marker) {
				t.Fatalf("body does not contain %q", test.marker)
			}
		})
	}

	script := performRequest(service, http.MethodGet, "/assets/app.js", "", nil).Body.String()
	if strings.Contains(script, "innerHTML") || !strings.Contains(script, "textContent") {
		t.Fatal("dashboard script must render untrusted values with textContent, not innerHTML")
	}
	post := performRequest(service, http.MethodPost, "/", "", nil)
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST dashboard status = %d, want %d", post.Code, http.StatusMethodNotAllowed)
	}
}

func TestWebhookBlocksUntilGranted(t *testing.T) {
	t.Parallel()

	service, store := newTestServer(t, nil)
	webhookDone := submitWebhook(service, validWebhookBody(t, "req-grant", approval.SupportedCommand))
	waitForPending(t, store)

	snapshot := performRequest(service, http.MethodGet, "/api/v1/approvals", "", nil)
	if snapshot.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d, want %d", snapshot.Code, http.StatusOK)
	}
	var state snapshotResponse
	decodeResponse(t, snapshot.Body, &state)
	if len(state.Pending) != 1 || state.Pending[0].Envelope.Request.RequestID != "req-grant" {
		t.Fatalf("snapshot pending = %+v, want req-grant", state.Pending)
	}

	decision := performDecision(service, "req-grant", `{"decision":"granted"}`, service.origin)
	if decision.Code != http.StatusOK {
		t.Fatalf("decision status = %d, want %d: %s", decision.Code, http.StatusOK, decision.Body.String())
	}

	webhook := awaitHTTPResponse(t, webhookDone)
	if webhook.Code != http.StatusOK {
		t.Fatalf("webhook status = %d, want %d", webhook.Code, http.StatusOK)
	}
	assertWebhookDecision(t, webhook.Body, "granted")
}

func TestWebhookDenialAndTimeoutFailClosed(t *testing.T) {
	t.Parallel()

	t.Run("denied", func(t *testing.T) {
		t.Parallel()
		service, store := newTestServer(t, nil)
		webhookDone := submitWebhook(service, validWebhookBody(t, "req-deny", approval.SupportedCommand))
		waitForPending(t, store)

		decision := performDecision(service, "req-deny", `{"decision":"denied","reason":"user denied"}`, service.origin)
		if decision.Code != http.StatusOK {
			t.Fatalf("decision status = %d, want %d", decision.Code, http.StatusOK)
		}
		webhook := awaitHTTPResponse(t, webhookDone)
		var response decisionResponse
		decodeResponse(t, webhook.Body, &response)
		if response.Decision != "denied" || response.Reason != "user denied" {
			t.Fatalf("webhook response = %+v, want denied with user reason", response)
		}
	})

	t.Run("expired", func(t *testing.T) {
		t.Parallel()
		service, _ := newTestServer(t, func(config *Config) {
			config.DecisionTimeout = 20 * time.Millisecond
		})
		webhook := awaitHTTPResponse(t, submitWebhook(service, validWebhookBody(t, "req-expire", approval.SupportedCommand)))
		var response decisionResponse
		decodeResponse(t, webhook.Body, &response)
		if response.Decision != "denied" || !strings.Contains(response.Reason, "timed out") {
			t.Fatalf("webhook response = %+v, want timeout denial", response)
		}
	})
}

func TestWebhookRejectsMalformedOversizedAndUnsupportedRequests(t *testing.T) {
	t.Parallel()

	service, _ := newTestServer(t, func(config *Config) {
		config.MaxWebhookBodyBytes = 1024
	})

	tests := []struct {
		name        string
		body        string
		contentType string
		wantStatus  int
		decision    string
	}{
		{
			name:        "wrong content type",
			body:        `{}`,
			contentType: "text/plain",
			wantStatus:  http.StatusUnsupportedMediaType,
		},
		{
			name:        "malformed",
			body:        `{`,
			contentType: "application/json",
			wantStatus:  http.StatusBadRequest,
		},
		{
			name:        "oversized",
			body:        strings.Repeat("x", 1025),
			contentType: "application/json",
			wantStatus:  http.StatusRequestEntityTooLarge,
			decision:    "",
		},
		{
			name:        "unsupported",
			body:        validWebhookBody(t, "req-git", "git"),
			contentType: "application/json",
			wantStatus:  http.StatusOK,
			decision:    "denied",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := newRequest(http.MethodPost, "/hooks/nono", test.body)
			request.Header.Set("Content-Type", test.contentType)
			response := httptest.NewRecorder()
			service.Handler().ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.wantStatus, response.Body.String())
			}
			if test.decision != "" {
				assertWebhookDecision(t, response.Body, test.decision)
			}
		})
	}
}

func TestDecisionRequiresExactOriginAndJSON(t *testing.T) {
	t.Parallel()

	service, store := newTestServer(t, nil)
	webhookDone := submitWebhook(service, validWebhookBody(t, "req-origin", approval.SupportedCommand))
	waitForPending(t, store)

	tests := []struct {
		name        string
		origin      string
		contentType string
		wantStatus  int
	}{
		{
			name:        "missing origin",
			contentType: "application/json",
			wantStatus:  http.StatusForbidden,
		},
		{
			name:        "cross origin",
			origin:      "https://evil.example",
			contentType: "application/json",
			wantStatus:  http.StatusForbidden,
		},
		{
			name:        "simple form",
			origin:      service.origin,
			contentType: "text/plain",
			wantStatus:  http.StatusUnsupportedMediaType,
		},
	}
	for _, test := range tests {
		request := newRequest(http.MethodPost, "/api/v1/approvals/req-origin/decision", `{"decision":"granted"}`)
		request.Header.Set("Origin", test.origin)
		request.Header.Set("Content-Type", test.contentType)
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, request)
		if response.Code != test.wantStatus {
			t.Errorf("%s: status = %d, want %d", test.name, response.Code, test.wantStatus)
		}
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("%s: Access-Control-Allow-Origin = %q, want empty", test.name, got)
		}
	}

	cleanup := performDecision(service, "req-origin", `{"decision":"denied"}`, service.origin)
	if cleanup.Code != http.StatusOK {
		t.Fatalf("cleanup decision status = %d, want %d", cleanup.Code, http.StatusOK)
	}
	_ = awaitHTTPResponse(t, webhookDone)
}

func TestLateAndUnknownDecisions(t *testing.T) {
	t.Parallel()

	service, store := newTestServer(t, nil)
	webhookDone := submitWebhook(service, validWebhookBody(t, "req-late", approval.SupportedCommand))
	waitForPending(t, store)
	first := performDecision(service, "req-late", `{"decision":"denied"}`, service.origin)
	if first.Code != http.StatusOK {
		t.Fatalf("first decision status = %d, want %d", first.Code, http.StatusOK)
	}
	_ = awaitHTTPResponse(t, webhookDone)

	late := performDecision(service, "req-late", `{"decision":"granted"}`, service.origin)
	if late.Code != http.StatusConflict {
		t.Fatalf("late decision status = %d, want %d", late.Code, http.StatusConflict)
	}
	unknown := performDecision(service, "missing", `{"decision":"denied"}`, service.origin)
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown decision status = %d, want %d", unknown.Code, http.StatusNotFound)
	}
}

func TestSSEPublishesSnapshotAndLifecycleEvents(t *testing.T) {
	t.Parallel()

	service, _ := newTestServer(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	eventRequest := newRequest(http.MethodGet, "/api/v1/events", "").WithContext(ctx)
	eventResponse := newStreamRecorder()
	eventDone := make(chan struct{})
	go func() {
		service.Handler().ServeHTTP(eventResponse, eventRequest)
		close(eventDone)
	}()
	waitForStreamContent(t, eventResponse, "event: snapshot")

	webhookResult := submitWebhook(service, validWebhookBody(t, "req-sse", approval.SupportedCommand))
	waitForStreamContent(t, eventResponse, "event: pending", "req-sse")

	decision := performDecision(service, "req-sse", `{"decision":"granted"}`, service.origin)
	if decision.Code != http.StatusOK {
		t.Fatalf("decision status = %d, want %d", decision.Code, http.StatusOK)
	}
	waitForStreamContent(t, eventResponse, "event: resolved", `"state":"granted"`)

	webhook := awaitHTTPResponse(t, webhookResult)
	assertWebhookDecision(t, webhook.Body, "granted")
	cancel()
	select {
	case <-eventDone:
	case <-time.After(time.Second):
		t.Fatal("SSE handler did not stop after cancellation")
	}
}

func TestSSEClientLimitIsBounded(t *testing.T) {
	t.Parallel()

	service, _ := newTestServer(t, func(config *Config) {
		config.MaxSSEClients = 1
	})
	ctx, cancel := context.WithCancel(context.Background())
	firstRequest := newRequest(http.MethodGet, "/api/v1/events", "").WithContext(ctx)
	firstResponse := newStreamRecorder()
	firstDone := make(chan struct{})
	go func() {
		service.Handler().ServeHTTP(firstResponse, firstRequest)
		close(firstDone)
	}()
	waitForStreamContent(t, firstResponse, "event: snapshot")

	second := performRequest(service, http.MethodGet, "/api/v1/events", "", nil)
	if second.Code != http.StatusServiceUnavailable {
		t.Fatalf("second SSE status = %d, want %d", second.Code, http.StatusServiceUnavailable)
	}

	cancel()
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("first SSE handler did not stop after cancellation")
	}
}

func TestReadyFailsAfterStoreShutdown(t *testing.T) {
	t.Parallel()

	service, store := newTestServer(t, nil)
	store.Shutdown("test")
	response := performRequest(service, http.MethodGet, "/readyz", "", nil)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}

func newTestServer(t *testing.T, mutate func(*Config)) (*Server, *approval.Store) {
	t.Helper()
	store := newApprovalStore(t)
	config := DefaultConfig()
	if mutate != nil {
		mutate(&config)
	}
	service, err := New(config, store)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return service, store
}

func newApprovalStore(t *testing.T) *approval.Store {
	t.Helper()
	store, err := approval.NewStore(approval.StoreConfig{MaxPending: 8, MaxRecent: 8})
	if err != nil {
		t.Fatalf("approval.NewStore() error = %v", err)
	}
	t.Cleanup(func() { store.Shutdown("test cleanup") })
	return store
}

func validWebhookBody(t *testing.T, requestID, command string) string {
	t.Helper()
	envelope := approval.WebhookEnvelope{
		Backend: "nono-hitl",
		Request: approval.CommandRequest{
			CapabilityType: approval.CapabilityCommand,
			RequestID:      requestID,
			Command:        command,
			Args:           []string{command, "status"},
			Caller:         "session",
			InterceptRule:  "invocation_policy.default",
			ChildPID:       1234,
			SessionID:      "session-1",
		},
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return string(body)
}

func newRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, "http://127.0.0.1:8765"+path, strings.NewReader(body))
	request.Host = defaultListenAddress
	return request
}

func performRequest(service *Server, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := newRequest(method, path, body)
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	return response
}

func performDecision(service *Server, requestID, body, origin string) *httptest.ResponseRecorder {
	return performRequest(
		service,
		http.MethodPost,
		"/api/v1/approvals/"+requestID+"/decision",
		body,
		map[string]string{
			"Content-Type": "application/json",
			"Origin":       origin,
		},
	)
}

func submitWebhook(service *Server, body string) <-chan *httptest.ResponseRecorder {
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- performRequest(
			service,
			http.MethodPost,
			"/hooks/nono",
			body,
			map[string]string{
				"Content-Type": "application/json",
			},
		)
	}()
	return result
}

func awaitHTTPResponse(t *testing.T, result <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case response := <-result:
		return response
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for HTTP response")
		return nil
	}
}

func waitForPending(t *testing.T, store *approval.Store) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(store.Pending()) == 1 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("len(Pending()) = %d, want 1", len(store.Pending()))
}

func decodeResponse(t *testing.T, reader io.Reader, value any) {
	t.Helper()
	if err := json.NewDecoder(reader).Decode(value); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func assertWebhookDecision(t *testing.T, body *bytes.Buffer, want string) {
	t.Helper()
	var response decisionResponse
	decodeResponse(t, body, &response)
	if response.Decision != want {
		t.Fatalf("decision = %q, want %q", response.Decision, want)
	}
}

type streamRecorder struct {
	header  http.Header
	mu      sync.Mutex
	body    bytes.Buffer
	status  int
	flushed chan struct{}
}

func newStreamRecorder() *streamRecorder {
	return &streamRecorder{
		header:  make(http.Header),
		flushed: make(chan struct{}, 1),
	}
}

func (r *streamRecorder) Header() http.Header {
	return r.header
}

func (r *streamRecorder) WriteHeader(status int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status == 0 {
		r.status = status
	}
}

func (r *streamRecorder) Write(data []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(data)
}

func (r *streamRecorder) Flush() {
	select {
	case r.flushed <- struct{}{}:
	default:
	}
}

func (r *streamRecorder) content() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}

func waitForStreamContent(t *testing.T, response *streamRecorder, fragments ...string) {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		content := response.content()
		matched := true
		for _, fragment := range fragments {
			if !strings.Contains(content, fragment) {
				matched = false
				break
			}
		}
		if matched {
			return
		}
		select {
		case <-response.flushed:
		case <-timer.C:
			t.Fatalf("stream content = %q, missing %q", content, fragments)
		}
	}
}
