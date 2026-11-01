package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/acidghost/nono-hitl/internal/approval"
	"github.com/acidghost/nono-hitl/internal/classifier"
	"github.com/acidghost/nono-hitl/internal/config"
)

const fakeOllamaURL = "http://ollama.test"

var dockerEntry = classifier.Entry{
	Prefix:  []string{"docker"},
	Ask:     "Is this docker command dangerous or risky?",
	Model:   "d3",
	MaxRisk: 0.3,
	Mode:    classifier.ModeAdvise,
}

func TestClassifierAdvisesWaitingRequests(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		answer    func(http.ResponseWriter, *http.Request)
		wantRisk  float64
		wantError string
	}{
		{name: "safe", answer: noul(0.002), wantRisk: 0.002},
		{name: "risky", answer: noul(0.91), wantRisk: 0.91},
		{
			name: "server error",
			answer: func(writer http.ResponseWriter, _ *http.Request) {
				writeJSON(writer, http.StatusNotFound, map[string]string{"error": "model 'd3' not found"})
			},
			wantError: "HTTP 404: model 'd3' not found",
		},
		{
			name: "no answer",
			answer: func(writer http.ResponseWriter, _ *http.Request) {
				writeJSON(writer, http.StatusOK, map[string]any{"answers": map[string]any{}})
			},
			wantError: "response has no answer",
		},
		{name: "out of range", answer: noul(1.5), wantError: "outside 0 to 1"},
		{
			name: "timeout",
			answer: func(_ http.ResponseWriter, request *http.Request) {
				<-request.Context().Done()
			},
			wantError: "no answer before the timeout",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			ollama := newFakeOllama(test.answer)
			service, store := newClassifiedServer(t, ollama, dockerEntry)
			webhookDone := submitWebhook(service, webhookBody(t, "req-docker", "docker", "run", "alpine"))

			advice := waitForAdvice(t, store, "req-docker")
			if advice.Model != "d3" || advice.Ask != dockerEntry.Ask || advice.MaxRisk != 0.3 || advice.Mode != "advise" {
				t.Fatalf("advice = %+v, want the docker entry", advice)
			}
			if test.wantError != "" {
				if advice.Risk != nil || !strings.Contains(advice.Error, test.wantError) {
					t.Fatalf("advice = %+v, want error %q", advice, test.wantError)
				}
			} else if advice.Risk == nil || *advice.Risk != test.wantRisk || advice.Error != "" {
				t.Fatalf("advice = %+v, want risk %v", advice, test.wantRisk)
			}

			want := `{"model":"d3","state":{"command":"docker","args":["docker","run","alpine"]},` +
				`"questions":{"risk":{"type":"noul","instructions":"Is this docker command dangerous or risky?"}}}`
			if got := ollama.requests(); len(got) != 1 || got[0] != want {
				t.Fatalf("Ollama requests = %q, want one %s", got, want)
			}

			// Advice never decides: the request still waits for a human.
			if pending := store.Pending(); len(pending) != 1 {
				t.Fatalf("len(Pending()) = %d, want 1", len(pending))
			}
			performDecision(service, "req-docker", `{"decision":"denied"}`, service.origin)
			assertWebhookDecision(t, awaitHTTPResponse(t, webhookDone).Body, "denied")
		})
	}
}

func TestClassifierAdviceReachesHistoryAfterTheDecision(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	ollama := newFakeOllama(func(writer http.ResponseWriter, request *http.Request) {
		<-release
		noul(0.05)(writer, request)
	})
	// A test that fails first must not leave the call blocked.
	var releaseOnce sync.Once
	answer := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(answer)
	service, store := newClassifiedServer(t, ollama, dockerEntry)
	webhookDone := submitWebhook(service, webhookBody(t, "req-early", "docker", "ps"))
	waitForPending(t, store)
	if advice := store.Pending()[0].Advice; advice == nil || advice.Risk != nil || advice.Error != "" {
		t.Fatalf("advice before the answer = %+v, want one still classifying", advice)
	}

	performDecision(service, "req-early", `{"decision":"granted"}`, service.origin)
	assertWebhookDecision(t, awaitHTTPResponse(t, webhookDone).Body, "granted")
	answer()

	advice := waitForAdvice(t, store, "req-early")
	if advice.Risk == nil || *advice.Risk != 0.05 {
		t.Fatalf("history advice = %+v, want risk 0.05", advice)
	}
}

func TestClassifierMatchesTheLongestPrefixOnly(t *testing.T) {
	t.Parallel()

	ollama := newFakeOllama(noul(0.1))
	runEntry := dockerEntry
	runEntry.Prefix = []string{"docker", "run"}
	runEntry.Ask = "Does this docker run command mount host paths?"
	service, store := newClassifiedServer(t, ollama, dockerEntry, runEntry)

	tests := []struct {
		id      string
		args    []string
		wantAsk string
	}{
		{id: "req-run", args: []string{"docker", "run", "alpine"}, wantAsk: runEntry.Ask},
		{id: "req-ps", args: []string{"docker", "ps"}, wantAsk: dockerEntry.Ask},
		{id: "req-git", args: []string{"git", "push"}},
	}
	for _, test := range tests {
		webhookDone := submitWebhook(service, webhookBody(t, test.id, test.args...))
		waitForPending(t, store)
		if test.wantAsk == "" {
			if advice := store.Pending()[0].Advice; advice != nil {
				t.Fatalf("%s: advice = %+v, want none", test.id, advice)
			}
		} else if advice := waitForAdvice(t, store, test.id); advice.Ask != test.wantAsk {
			t.Fatalf("%s: ask = %q, want %q", test.id, advice.Ask, test.wantAsk)
		}
		performDecision(service, test.id, `{"decision":"denied"}`, service.origin)
		_ = awaitHTTPResponse(t, webhookDone)
	}
	if got := len(ollama.requests()); got != 2 {
		t.Fatalf("Ollama calls = %d, want 2", got)
	}
}

func TestClassifierSkipsRequestsReleasedBySessionApprovals(t *testing.T) {
	t.Parallel()

	ollama := newFakeOllama(noul(0.1))
	service, store := newClassifiedServer(t, ollama, dockerEntry)
	webhookDone := submitWebhook(service, webhookBody(t, "req-first", "docker", "ps"))
	waitForAdvice(t, store, "req-first")
	performDecision(service, "req-first", `{"decision":"granted","scope":"session"}`, service.origin)
	_ = awaitHTTPResponse(t, webhookDone)

	repeat := awaitHTTPResponse(t, submitWebhook(service, webhookBody(t, "req-repeat", "docker", "ps")))
	assertWebhookDecision(t, repeat.Body, "granted")
	if got := len(ollama.requests()); got != 1 {
		t.Fatalf("Ollama calls = %d, want 1", got)
	}
	if advice := store.Recent()[0].Advice; advice != nil {
		t.Fatalf("released request advice = %+v, want none", advice)
	}
}

func TestClassifierDecidesUnderDenyAndForward(t *testing.T) {
	t.Parallel()

	down := func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "model runner stopped"})
	}
	hang := func(_ http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	}
	tests := []struct {
		name   string
		mode   classifier.Mode
		answer func(http.ResponseWriter, *http.Request)
		want   string
	}{
		{name: "deny pass", mode: classifier.ModeDeny, answer: noul(0.1), want: "granted"},
		{name: "deny fail", mode: classifier.ModeDeny, answer: noul(0.91), want: "denied"},
		{name: "deny down", mode: classifier.ModeDeny, answer: down, want: "denied"},
		{name: "deny timeout", mode: classifier.ModeDeny, answer: hang, want: "denied"},
		{name: "forward pass", mode: classifier.ModeForward, answer: noul(0.1), want: "granted"},
		{name: "forward fail", mode: classifier.ModeForward, answer: noul(0.91), want: "forwarded"},
		{name: "forward down", mode: classifier.ModeForward, answer: down, want: "forwarded"},
		{name: "forward timeout", mode: classifier.ModeForward, answer: hang, want: "forwarded"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			ollama := newFakeOllama(test.answer)
			entry := dockerEntry
			entry.Mode = test.mode
			service, store := newClassifiedServer(t, ollama, entry)
			events, unsubscribe := store.Subscribe(8)
			defer unsubscribe()
			webhookDone := submitWebhook(service, webhookBody(t, "req-docker", "docker", "run", "alpine"))

			if test.want == "forwarded" {
				waitForPending(t, store)
				pending := store.Pending()[0]
				if advice := pending.Advice; advice == nil || (advice.Risk == nil && advice.Error == "") {
					t.Fatalf("forwarded advice = %+v, want the model's answer or error", advice)
				}
				if left := pending.Deadline.Sub(pending.CreatedAt); left >= service.config.DecisionTimeout {
					t.Fatalf("forwarded request has %v left, want less than the decision timeout", left)
				}
				performDecision(service, "req-docker", `{"decision":"denied"}`, service.origin)
				assertWebhookDecision(t, awaitHTTPResponse(t, webhookDone).Body, "denied")
				return
			}

			var response decisionResponse
			decodeResponse(t, awaitHTTPResponse(t, webhookDone).Body, &response)
			if response.Decision != test.want {
				t.Fatalf("decision = %q, want %q", response.Decision, test.want)
			}
			if test.want == "denied" && response.Reason != classifierDenial {
				t.Fatalf("denial reason = %q, want %q with no score", response.Reason, classifierDenial)
			}
			recent := store.Recent()
			if len(recent) != 1 || recent[0].Resolution.DecidedBy != approval.DecidedByClassifier {
				t.Fatalf("Recent() = %+v, want one request decided by the classifier", recent)
			}
			if advice := recent[0].Advice; advice == nil || advice.Mode != string(test.mode) {
				t.Fatalf("history advice = %+v, want the %s entry's", advice, test.mode)
			}
			for len(events) > 0 {
				if event := <-events; event.Kind == approval.EventPending {
					t.Fatal("a request the model decided was queued for a human")
				}
			}
			if got := len(ollama.requests()); got != 1 {
				t.Fatalf("Ollama calls = %d, want 1", got)
			}
		})
	}
}

func TestClassifierSkipsTheModelForSessionApprovalsInEveryMode(t *testing.T) {
	t.Parallel()

	for _, mode := range []classifier.Mode{classifier.ModeDeny, classifier.ModeForward} {
		t.Run(string(mode), func(t *testing.T) {
			t.Parallel()
			ollama := newFakeOllama(noul(0.91))
			service, store := newClassifiedServer(t, ollama)
			webhookDone := submitWebhook(service, webhookBody(t, "req-first", "docker", "ps"))
			waitForPending(t, store)
			performDecision(service, "req-first", `{"decision":"granted","scope":"session"}`, service.origin)
			_ = awaitHTTPResponse(t, webhookDone)

			entry := dockerEntry
			entry.Mode = mode
			file := config.File{OllamaURL: fakeOllamaURL, Classifiers: []classifier.Entry{entry}}
			if err := service.saveFile(file); err != nil {
				t.Fatalf("saveFile() error = %v", err)
			}
			repeat := awaitHTTPResponse(t, submitWebhook(service, webhookBody(t, "req-repeat", "docker", "ps")))
			assertWebhookDecision(t, repeat.Body, "granted")
			if got := len(ollama.requests()); got != 0 {
				t.Fatalf("Ollama calls = %d, want 0", got)
			}
			if resolution := store.Recent()[0].Resolution; resolution.Scope != approval.ScopeSession {
				t.Fatalf("resolution = %+v, want a session approval", resolution)
			}
		})
	}
}

func TestClassifierCallEndsAndDeniesOnShutdown(t *testing.T) {
	t.Parallel()

	called := make(chan struct{})
	ollama := newFakeOllama(func(_ http.ResponseWriter, request *http.Request) {
		close(called)
		<-request.Context().Done()
	})
	entry := dockerEntry
	entry.Mode = classifier.ModeForward
	service, store := newClassifiedServer(t, ollama, entry)
	service.config.ClassifierTimeout = time.Minute
	webhookDone := submitWebhook(service, webhookBody(t, "req-docker", "docker", "ps"))
	awaitClosed(t, called)

	store.Shutdown("test shutdown")
	var response decisionResponse
	decodeResponse(t, awaitHTTPResponse(t, webhookDone).Body, &response)
	if response.Decision != "denied" || response.Reason != "Approval service is shutting down" {
		t.Fatalf("response = %+v, want a denial for the shutdown", response)
	}
}

func TestClassifierStopsWhenNonoDropsTheRequest(t *testing.T) {
	t.Parallel()

	called := make(chan struct{})
	ollama := newFakeOllama(func(_ http.ResponseWriter, request *http.Request) {
		close(called)
		<-request.Context().Done()
	})
	entry := dockerEntry
	entry.Mode = classifier.ModeDeny
	service, store := newClassifiedServer(t, ollama, entry)
	service.config.ClassifierTimeout = time.Minute
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := newRequest(http.MethodPost, "/hooks/nono", webhookBody(t, "req-docker", "docker", "ps")).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	served := make(chan struct{})
	go func() {
		service.Handler().ServeHTTP(httptest.NewRecorder(), request)
		close(served)
	}()
	awaitClosed(t, called)

	cancel()
	awaitClosed(t, served)
	if pending, recent, _ := store.Snapshot(); len(pending) != 0 || len(recent) != 0 {
		t.Fatalf("Snapshot() = %+v, %+v; want nothing recorded", pending, recent)
	}
}

func awaitClosed(t *testing.T, channel <-chan struct{}) {
	t.Helper()
	select {
	case <-channel:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out")
	}
}

// fakeOllama answers /v1/systemone in process, since sandboxes running the
// tests may refuse loopback connections. It records each request body.
type fakeOllama struct {
	answer func(http.ResponseWriter, *http.Request)
	mu     sync.Mutex
	bodies []string
}

func newFakeOllama(answer func(http.ResponseWriter, *http.Request)) *fakeOllama {
	return &fakeOllama{answer: answer}
}

func (f *fakeOllama) RoundTrip(request *http.Request) (*http.Response, error) {
	response := httptest.NewRecorder()
	if request.Method != http.MethodPost || request.URL.String() != fakeOllamaURL+"/v1/systemone" {
		http.NotFound(response, request)
		return response.Result(), nil
	}
	var body json.RawMessage
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.bodies = append(f.bodies, string(body))
	f.mu.Unlock()
	f.answer(response, request)
	// A real transport fails a call whose context ended.
	if err := request.Context().Err(); err != nil {
		return nil, err
	}
	return response.Result(), nil
}

func (f *fakeOllama) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.bodies...)
}

func noul(risk float64) func(http.ResponseWriter, *http.Request) {
	return func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{
			"model":   "d3",
			"answers": map[string]any{"risk": map[string]any{"type": "noul", "noul": risk}},
		})
	}
}

func newClassifiedServer(
	t *testing.T,
	ollama *fakeOllama,
	entries ...classifier.Entry,
) (*Server, *approval.Store) {
	t.Helper()
	service, store := newTestServer(t, func(serverConfig *Config) {
		serverConfig.File = config.File{OllamaURL: fakeOllamaURL, Classifiers: entries}
		serverConfig.ClassifierTimeout = 100 * time.Millisecond
	})
	client, err := classifier.NewClient(fakeOllamaURL, ollama)
	if err != nil {
		t.Fatalf("classifier.NewClient() error = %v", err)
	}
	service.ollama = client
	return service, store
}

func webhookBody(t *testing.T, requestID string, args ...string) string {
	t.Helper()
	body := validWebhookBody(t, requestID, args[0])
	var envelope approval.WebhookEnvelope
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Request.Args = args
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// waitForAdvice returns the advice of a pending or recent request once the
// model answered or failed.
func waitForAdvice(t *testing.T, store *approval.Store, requestID string) approval.Advice {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		pending, recent, _ := store.Snapshot()
		for _, item := range append(pending, recent...) {
			advice := item.Advice
			if item.Envelope.Request.RequestID == requestID && advice != nil && (advice.Risk != nil || advice.Error != "") {
				return *advice
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("request %s got no advice", requestID)
	return approval.Advice{}
}
