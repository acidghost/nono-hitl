// Package approval defines nono webhook requests and their in-memory lifecycle.
package approval

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	CapabilityCommand = "command"
	SupportedCommand  = "gh"

	maxBackendBytes   = 128
	maxRequestIDBytes = 512
	maxCommandBytes   = 256
	maxArguments      = 256
	maxArgumentBytes  = 8 * 1024
	maxArgumentsBytes = 32 * 1024
	maxMetadataBytes  = 4 * 1024
)

var (
	ErrInvalidRequest        = errors.New("invalid approval request")
	ErrUnsupportedCapability = errors.New("unsupported approval capability")
	ErrUnsupportedCommand    = errors.New("unsupported approval command")
)

// WebhookEnvelope is the payload sent by nono's webhook approval backend.
type WebhookEnvelope struct {
	Backend string         `json:"backend"`
	Request CommandRequest `json:"request"`
}

// CommandRequest is nono's command-launch approval request.
type CommandRequest struct {
	CapabilityType string   `json:"capability_type"`
	RequestID      string   `json:"request_id"`
	Command        string   `json:"command"`
	Args           []string `json:"args"`
	Caller         string   `json:"caller"`
	InterceptRule  string   `json:"intercept_rule"`
	Reason         *string  `json:"reason"`
	ChildPID       uint32   `json:"child_pid"`
	SessionID      string   `json:"session_id"`
}

type wireEnvelope struct {
	Backend string          `json:"backend"`
	Request json.RawMessage `json:"request"`
}

type requestHeader struct {
	CapabilityType string `json:"capability_type"`
}

// DecodeWebhook decodes and validates one nono webhook payload. Unknown JSON
// fields are tolerated so additions to nono's wire format do not break the MVP.
func DecodeWebhook(r io.Reader) (WebhookEnvelope, error) {
	var wire wireEnvelope
	if err := decodeOne(r, &wire); err != nil {
		return WebhookEnvelope{}, fmt.Errorf("%w: decode envelope: %v", ErrInvalidRequest, err)
	}

	if wire.Backend == "" || len(wire.Backend) > maxBackendBytes {
		return WebhookEnvelope{}, fmt.Errorf("%w: backend must contain 1 to %d bytes", ErrInvalidRequest, maxBackendBytes)
	}
	if len(wire.Request) == 0 || string(wire.Request) == "null" {
		return WebhookEnvelope{}, fmt.Errorf("%w: request is required", ErrInvalidRequest)
	}

	var header requestHeader
	if err := json.Unmarshal(wire.Request, &header); err != nil {
		return WebhookEnvelope{}, fmt.Errorf("%w: decode request: %v", ErrInvalidRequest, err)
	}
	if header.CapabilityType != CapabilityCommand {
		return WebhookEnvelope{}, fmt.Errorf("%w: %q", ErrUnsupportedCapability, header.CapabilityType)
	}

	var request CommandRequest
	if err := json.Unmarshal(wire.Request, &request); err != nil {
		return WebhookEnvelope{}, fmt.Errorf("%w: decode command request: %v", ErrInvalidRequest, err)
	}
	if err := request.Validate(); err != nil {
		return WebhookEnvelope{}, err
	}

	return WebhookEnvelope{Backend: wire.Backend, Request: request}, nil
}

// Validate checks the fields accepted and displayed by the MVP.
func (r CommandRequest) Validate() error {
	if r.CapabilityType != CapabilityCommand {
		return fmt.Errorf("%w: %q", ErrUnsupportedCapability, r.CapabilityType)
	}
	if r.Command != SupportedCommand {
		return fmt.Errorf("%w: %q", ErrUnsupportedCommand, r.Command)
	}
	if r.RequestID == "" || len(r.RequestID) > maxRequestIDBytes {
		return fmt.Errorf("%w: request_id must contain 1 to %d bytes", ErrInvalidRequest, maxRequestIDBytes)
	}
	if len(r.Command) > maxCommandBytes {
		return fmt.Errorf("%w: command exceeds %d bytes", ErrInvalidRequest, maxCommandBytes)
	}
	if len(r.Args) == 0 || len(r.Args) > maxArguments {
		return fmt.Errorf("%w: args must contain 1 to %d entries", ErrInvalidRequest, maxArguments)
	}

	totalArgumentBytes := 0
	for i, arg := range r.Args {
		if len(arg) > maxArgumentBytes {
			return fmt.Errorf("%w: args[%d] exceeds %d bytes", ErrInvalidRequest, i, maxArgumentBytes)
		}
		totalArgumentBytes += len(arg)
		if totalArgumentBytes > maxArgumentsBytes {
			return fmt.Errorf("%w: args exceed %d total bytes", ErrInvalidRequest, maxArgumentsBytes)
		}
	}

	if err := validateMetadata("caller", r.Caller, true); err != nil {
		return err
	}
	if err := validateMetadata("intercept_rule", r.InterceptRule, true); err != nil {
		return err
	}
	if err := validateMetadata("session_id", r.SessionID, true); err != nil {
		return err
	}
	if r.Reason != nil {
		if err := validateMetadata("reason", *r.Reason, false); err != nil {
			return err
		}
	}

	return nil
}

func validateMetadata(name, value string, required bool) error {
	if required && value == "" {
		return fmt.Errorf("%w: %s is required", ErrInvalidRequest, name)
	}
	if len(value) > maxMetadataBytes {
		return fmt.Errorf("%w: %s exceeds %d bytes", ErrInvalidRequest, name, maxMetadataBytes)
	}
	return nil
}

func decodeOne(r io.Reader, value any) error {
	decoder := json.NewDecoder(r)
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

func cloneEnvelope(envelope WebhookEnvelope) WebhookEnvelope {
	cloned := envelope
	cloned.Request.Args = append([]string(nil), envelope.Request.Args...)
	if envelope.Request.Reason != nil {
		reason := *envelope.Request.Reason
		cloned.Request.Reason = &reason
	}
	return cloned
}
