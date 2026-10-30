package classifier

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

const (
	maxResponseBytes = 64 * 1024
	maxErrorBytes    = 200
	// questionName names the one question in each call.
	questionName = "risk"
)

// Client calls Ollama's /v1/systemone endpoint.
type Client struct {
	endpoint string
	http     *http.Client
}

type systemOneRequest struct {
	Model     string              `json:"model"`
	State     systemOneState      `json:"state"`
	Questions map[string]question `json:"questions"`
}

type systemOneState struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

type question struct {
	Type         string `json:"type"`
	Instructions string `json:"instructions"`
}

type systemOneResponse struct {
	Answers map[string]struct {
		Noul *float64 `json:"noul"`
	} `json:"answers"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// NewClient calls the Ollama instance at ollamaURL, which Validate has
// checked. A nil transport uses the default one. Calls are bounded by the
// caller's context.
func NewClient(ollamaURL string, transport http.RoundTripper) (*Client, error) {
	endpoint, err := url.JoinPath(ollamaURL, "v1", "systemone")
	if err != nil {
		return nil, fmt.Errorf("invalid ollama_url %q: %w", ollamaURL, err)
	}
	return &Client{
		endpoint: endpoint,
		http: &http.Client{
			Transport: transport,
			// ollama_url decides where command arguments go; a redirect must not.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

// Risk asks entry's model its ask about the request and returns the
// probability that the answer is true.
func (c *Client) Risk(ctx context.Context, entry Entry, command string, args []string) (float64, error) {
	body, err := json.Marshal(systemOneRequest{
		Model: entry.Model,
		State: systemOneState{Command: command, Args: args},
		Questions: map[string]question{
			questionName: {Type: "noul", Instructions: entry.Ask},
		},
	})
	if err != nil {
		return 0, fmt.Errorf("encode request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, fmt.Errorf("build request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return 0, errors.New("no answer before the timeout")
		}
		// Drops the "Post <url>:" prefix, which the card has no room for.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return 0, err
	}
	defer func() { _ = response.Body.Close() }()

	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return 0, fmt.Errorf("read response: %w", err)
	}
	if len(data) > maxResponseBytes {
		return 0, fmt.Errorf("response exceeds %d bytes", maxResponseBytes)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var failure errorResponse
		_ = json.Unmarshal(data, &failure)
		if failure.Error == "" {
			return 0, fmt.Errorf("HTTP %d", response.StatusCode)
		}
		return 0, fmt.Errorf("HTTP %d: %s", response.StatusCode, shorten(failure.Error))
	}

	var answer systemOneResponse
	if err := json.Unmarshal(data, &answer); err != nil {
		return 0, fmt.Errorf("decode response: %w", err)
	}
	risk := answer.Answers[questionName].Noul
	if risk == nil {
		return 0, errors.New("response has no answer")
	}
	if !(*risk >= 0 && *risk <= 1) {
		return 0, fmt.Errorf("answer %v is outside 0 to 1", *risk)
	}
	return *risk, nil
}

// shorten cuts Ollama's error text to maxErrorBytes on a rune boundary.
func shorten(text string) string {
	text = strings.ToValidUTF8(text, "?")
	if len(text) <= maxErrorBytes {
		return text
	}
	cut := maxErrorBytes
	for !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "…"
}
