package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/acidghost/nono-hitl/internal/approval"
	"github.com/acidghost/nono-hitl/internal/webui"
)

const maxDecisionReasonBytes = 4 * 1024

type decisionRequest struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}

type decisionResponse struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}

type snapshotResponse struct {
	Pending []approval.Approval `json:"pending"`
	Recent  []approval.Approval `json:"recent"`
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	ui := webui.Handler()
	mux.Handle("GET /{$}", ui)
	mux.Handle("GET /assets/app.js", ui)
	mux.Handle("GET /assets/style.css", ui)
	mux.HandleFunc("POST /hooks/nono", s.handleWebhook)
	mux.HandleFunc("GET /api/v1/approvals", s.handleSnapshot)
	mux.HandleFunc("GET /api/v1/events", s.handleEvents)
	mux.HandleFunc("POST /api/v1/approvals/{id}/decision", s.handleDecision)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /readyz", s.handleReady)
	return s.securityHeaders(s.validateHost(mux))
}

func (s *Server) handleWebhook(writer http.ResponseWriter, request *http.Request) {
	if !isJSON(request.Header.Get("Content-Type")) {
		writeError(writer, http.StatusUnsupportedMediaType, "content type must be application/json")
		return
	}

	body, tooLarge, err := readBounded(request.Body, s.config.MaxWebhookBodyBytes)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "could not read request body")
		return
	}
	if tooLarge {
		writeError(writer, http.StatusRequestEntityTooLarge, "request body is too large")
		return
	}

	envelope, err := approval.DecodeWebhook(bytes.NewReader(body))
	if err != nil {
		if errors.Is(err, approval.ErrUnsupportedCapability) || errors.Is(err, approval.ErrUnsupportedCommand) {
			writeJSON(writer, http.StatusOK, decisionResponse{
				Decision: "denied",
				Reason:   "Unsupported approval request",
			})
			return
		}
		writeError(writer, http.StatusBadRequest, "invalid approval request")
		return
	}

	resolution, err := s.store.Submit(request.Context(), envelope, s.config.DecisionTimeout)
	if err != nil {
		writeJSON(writer, http.StatusOK, decisionResponse{
			Decision: "denied",
			Reason:   submissionErrorReason(err),
		})
		return
	}
	writeResolution(writer, resolution)
}

func (s *Server) handleSnapshot(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, s.snapshot())
}

func (s *Server) handleDecision(writer http.ResponseWriter, request *http.Request) {
	if request.Header.Get("Origin") != s.origin {
		writeError(writer, http.StatusForbidden, "decision requires the local UI origin")
		return
	}
	if !isJSON(request.Header.Get("Content-Type")) {
		writeError(writer, http.StatusUnsupportedMediaType, "content type must be application/json")
		return
	}

	body, tooLarge, err := readBounded(request.Body, s.config.MaxDecisionBodyBytes)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "could not read request body")
		return
	}
	if tooLarge {
		writeError(writer, http.StatusRequestEntityTooLarge, "request body is too large")
		return
	}

	var requested decisionRequest
	if err := decodeStrictJSON(body, &requested); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid decision request")
		return
	}
	if len(requested.Reason) > maxDecisionReasonBytes {
		writeError(writer, http.StatusBadRequest, "decision reason is too large")
		return
	}

	state, ok := parseDecision(requested.Decision)
	if !ok {
		writeError(writer, http.StatusBadRequest, "decision must be granted or denied")
		return
	}
	resolution, err := s.store.Decide(request.PathValue("id"), state, requested.Reason)
	if err != nil {
		switch {
		case errors.Is(err, approval.ErrAlreadyResolved):
			writeError(writer, http.StatusConflict, "approval is already resolved")
		case errors.Is(err, approval.ErrNotFound):
			writeError(writer, http.StatusNotFound, "approval was not found")
		default:
			writeError(writer, http.StatusInternalServerError, "could not resolve approval")
		}
		return
	}
	writeJSON(writer, http.StatusOK, resolution)
}

func (s *Server) handleEvents(writer http.ResponseWriter, request *http.Request) {
	select {
	case s.sseSlots <- struct{}{}:
		defer func() { <-s.sseSlots }()
	default:
		writeError(writer, http.StatusServiceUnavailable, "too many event clients")
		return
	}

	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "streaming is unavailable")
		return
	}

	events, unsubscribe := s.store.Subscribe(defaultSSEBuffer)
	defer unsubscribe()

	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-store")
	writer.Header().Set("Connection", "keep-alive")
	writer.WriteHeader(http.StatusOK)
	if err := writeSSE(writer, "snapshot", s.snapshot()); err != nil {
		return
	}
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case event, open := <-events:
			if !open {
				return
			}
			if err := writeSSE(writer, string(event.Kind), event.Approval); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(writer, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) handleHealth(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleReady(writer http.ResponseWriter, _ *http.Request) {
	if s.store.IsClosed() {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"status": "not ready"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) validateHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Host != s.host {
			writeError(writer, http.StatusMisdirectedRequest, "unexpected host")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		header := writer.Header()
		header.Set(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'",
		)
		header.Set("Referrer-Policy", "no-referrer")
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("X-Frame-Options", "DENY")
		header.Set("Cache-Control", "no-store")
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) snapshot() snapshotResponse {
	pending, recent := s.store.Snapshot()
	return snapshotResponse{Pending: pending, Recent: recent}
}

func writeResolution(writer http.ResponseWriter, resolution approval.Resolution) {
	if resolution.State == approval.StateGranted {
		writeJSON(writer, http.StatusOK, decisionResponse{Decision: "granted"})
		return
	}
	reason := resolution.Reason
	if reason == "" {
		reason = "Approval request denied"
	}
	writeJSON(writer, http.StatusOK, decisionResponse{Decision: "denied", Reason: reason})
}

func submissionErrorReason(err error) string {
	switch {
	case errors.Is(err, approval.ErrStoreClosed):
		return "Approval service is shutting down"
	case errors.Is(err, approval.ErrStoreFull):
		return "Approval queue is full"
	case errors.Is(err, approval.ErrDuplicate):
		return "Duplicate approval request"
	default:
		return "Approval request could not be queued"
	}
}

func parseDecision(value string) (approval.State, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "grant", "granted", "approve", "approved", "allow", "allowed":
		return approval.StateGranted, true
	case "deny", "denied", "reject", "rejected", "block", "blocked":
		return approval.StateDenied, true
	default:
		return "", false
	}
}

func isJSON(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && strings.EqualFold(mediaType, "application/json")
}

func readBounded(reader io.Reader, limit int64) ([]byte, bool, error) {
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(body)) > limit {
		return nil, true, nil
	}
	return body, false, nil
}

func decodeStrictJSON(body []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return fmt.Errorf("trailing data: %w", err)
	}
	return nil
}

func writeSSE(writer io.Writer, event string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal SSE event: %w", err)
	}
	if _, err := fmt.Fprintf(writer, "event: %s\ndata: %s\n\n", event, data); err != nil {
		return fmt.Errorf("write SSE event: %w", err)
	}
	return nil
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}
