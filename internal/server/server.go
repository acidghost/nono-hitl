// Package server exposes the local nono approval webhook and browser API.
package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/acidghost/nono-hitl/internal/approval"
)

const (
	defaultListenAddress     = "127.0.0.1:8765"
	defaultDecisionTimeout   = 55 * time.Second
	defaultWebhookBodyBytes  = 64 * 1024
	defaultDecisionBodyBytes = 4 * 1024
	defaultMaxSSEClients     = 16
	defaultSSEBuffer         = 32
)

// Config controls the bounded local HTTP service.
type Config struct {
	ListenAddress        string
	DecisionTimeout      time.Duration
	MaxWebhookBodyBytes  int64
	MaxDecisionBodyBytes int64
	MaxSSEClients        int
}

// DefaultConfig returns secure MVP defaults.
func DefaultConfig() Config {
	return Config{
		ListenAddress:        defaultListenAddress,
		DecisionTimeout:      defaultDecisionTimeout,
		MaxWebhookBodyBytes:  defaultWebhookBodyBytes,
		MaxDecisionBodyBytes: defaultDecisionBodyBytes,
		MaxSSEClients:        defaultMaxSSEClients,
	}
}

// Server is the loopback-only HTTP approval service.
type Server struct {
	config        Config
	store         *approval.Store
	host          string
	origin        string
	handler       http.Handler
	sseSlots      chan struct{}
	listening     chan struct{}
	listeningOnce sync.Once
}

// New validates configuration and builds an HTTP service.
func New(config Config, store *approval.Store) (*Server, error) {
	if store == nil {
		return nil, errors.New("approval store is required")
	}
	applyDefaults(&config)
	host, err := validateListenAddress(config.ListenAddress)
	if err != nil {
		return nil, err
	}
	if config.DecisionTimeout <= 0 {
		return nil, errors.New("decision timeout must be positive")
	}
	if config.MaxWebhookBodyBytes <= 0 {
		return nil, errors.New("maximum webhook body size must be positive")
	}
	if config.MaxDecisionBodyBytes <= 0 {
		return nil, errors.New("maximum decision body size must be positive")
	}
	if config.MaxSSEClients <= 0 {
		return nil, errors.New("maximum SSE clients must be positive")
	}

	server := &Server{
		config:    config,
		store:     store,
		host:      host,
		origin:    "http://" + host,
		sseSlots:  make(chan struct{}, config.MaxSSEClients),
		listening: make(chan struct{}),
	}
	server.handler = server.routes()
	return server, nil
}

// Handler returns the service's HTTP handler for tests and embedding.
func (s *Server) Handler() http.Handler {
	return s.handler
}

// URL returns the plain loopback dashboard URL.
func (s *Server) URL() string {
	return s.origin + "/"
}

// Listening is closed after Run successfully binds the configured listener.
func (s *Server) Listening() <-chan struct{} {
	return s.listening
}

// Run listens until the context is canceled or the HTTP server fails. A Server
// is intended to be run once.
func (s *Server) Run(ctx context.Context) error {
	listener, err := net.Listen("tcp", s.host)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", s.host, err)
	}
	s.listeningOnce.Do(func() { close(s.listening) })

	httpServer := &http.Server{
		Addr:              s.host,
		Handler:           s.handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- httpServer.Serve(listener)
	}()

	select {
	case err := <-serveErr:
		s.store.Shutdown("approval HTTP server stopped")
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve approval HTTP API: %w", err)
	case <-ctx.Done():
		s.store.Shutdown("approval service shut down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			_ = httpServer.Close()
			return fmt.Errorf("shut down approval HTTP API: %w", err)
		}
		return nil
	}
}

func applyDefaults(config *Config) {
	defaults := DefaultConfig()
	if config.ListenAddress == "" {
		config.ListenAddress = defaults.ListenAddress
	}
	if config.DecisionTimeout == 0 {
		config.DecisionTimeout = defaults.DecisionTimeout
	}
	if config.MaxWebhookBodyBytes == 0 {
		config.MaxWebhookBodyBytes = defaults.MaxWebhookBodyBytes
	}
	if config.MaxDecisionBodyBytes == 0 {
		config.MaxDecisionBodyBytes = defaults.MaxDecisionBodyBytes
	}
	if config.MaxSSEClients == 0 {
		config.MaxSSEClients = defaults.MaxSSEClients
	}
}

func validateListenAddress(address string) (string, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return "", fmt.Errorf("invalid listen address %q: %w", address, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.Equal(net.IPv4(127, 0, 0, 1)) {
		return "", fmt.Errorf("listen address must use literal 127.0.0.1, got %q", host)
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return "", fmt.Errorf("listen address has invalid port %q", portText)
	}
	return net.JoinHostPort("127.0.0.1", strconv.FormatUint(port, 10)), nil
}
