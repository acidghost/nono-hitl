// Package approval defines nono webhook requests and their in-memory lifecycle.
package approval

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
)

const (
	CapabilityCommand = "command"
	CapabilityNetwork = "network"

	maxBackendBytes    = 128
	maxRequestIDBytes  = 512
	maxCommandBytes    = 256
	maxArguments       = 256
	maxArgumentBytes   = 8 * 1024
	maxArgumentsBytes  = 32 * 1024
	maxMetadataBytes   = 4 * 1024
	maxHostBytes       = 253
	maxProtocolBytes   = 32
	maxResolvedIPs     = 64
	maxResolvedIPBytes = 64
)

var (
	ErrInvalidRequest        = errors.New("invalid approval request")
	ErrUnsupportedCapability = errors.New("unsupported approval capability")
)

// WebhookEnvelope is the payload sent by nono's webhook approval backend.
type WebhookEnvelope struct {
	Backend string  `json:"backend"`
	Request Request `json:"request"`
}

// Request is one nono approval request, in nono's flat wire shape.
// CapabilityType says which kind it is and which group of fields it carries;
// the other group stays empty.
type Request struct {
	CapabilityType string  `json:"capability_type"`
	RequestID      string  `json:"request_id"`
	Reason         *string `json:"reason"`
	ChildPID       uint32  `json:"child_pid"`
	SessionID      string  `json:"session_id"`

	// Command launch.
	Command       string   `json:"command,omitempty"`
	Args          []string `json:"args,omitempty"`
	Caller        string   `json:"caller,omitempty"`
	InterceptRule string   `json:"intercept_rule,omitempty"`

	// Network connection through nono's proxy.
	Host        string   `json:"host,omitempty"`
	Port        uint16   `json:"port,omitempty"`
	Protocol    string   `json:"protocol,omitempty"`
	ResolvedIPs []string `json:"resolved_ips,omitempty"`
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
	if header.CapabilityType != CapabilityCommand && header.CapabilityType != CapabilityNetwork {
		return WebhookEnvelope{}, fmt.Errorf("%w: %q", ErrUnsupportedCapability, header.CapabilityType)
	}

	var request Request
	if err := json.Unmarshal(wire.Request, &request); err != nil {
		return WebhookEnvelope{}, fmt.Errorf("%w: decode %s request: %v", ErrInvalidRequest, header.CapabilityType, err)
	}
	if err := request.Validate(); err != nil {
		return WebhookEnvelope{}, err
	}

	return WebhookEnvelope{Backend: wire.Backend, Request: request}, nil
}

// Validate checks the fields accepted and displayed for the request's kind.
func (r Request) Validate() error {
	if r.RequestID == "" || len(r.RequestID) > maxRequestIDBytes {
		return fmt.Errorf("%w: request_id must contain 1 to %d bytes", ErrInvalidRequest, maxRequestIDBytes)
	}
	if r.Reason != nil {
		if err := validateMetadata("reason", *r.Reason, false); err != nil {
			return err
		}
	}

	switch r.CapabilityType {
	case CapabilityCommand:
		return r.validateCommand()
	case CapabilityNetwork:
		return r.validateNetwork()
	default:
		return fmt.Errorf("%w: %q", ErrUnsupportedCapability, r.CapabilityType)
	}
}

func (r Request) validateCommand() error {
	if r.Host != "" || r.Port != 0 || r.Protocol != "" || len(r.ResolvedIPs) > 0 {
		return fmt.Errorf("%w: command request carries network fields", ErrInvalidRequest)
	}
	if r.Command == "" || len(r.Command) > maxCommandBytes {
		return fmt.Errorf("%w: command must contain 1 to %d bytes", ErrInvalidRequest, maxCommandBytes)
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
	return validateMetadata("session_id", r.SessionID, true)
}

// validateNetwork accepts an empty session_id: standalone nono proxy sends
// none.
func (r Request) validateNetwork() error {
	if r.Command != "" || len(r.Args) > 0 || r.Caller != "" || r.InterceptRule != "" {
		return fmt.Errorf("%w: network request carries command fields", ErrInvalidRequest)
	}
	if err := validateToken("host", r.Host, maxHostBytes); err != nil {
		return err
	}
	if r.Port == 0 {
		return fmt.Errorf("%w: port must be 1 to 65535", ErrInvalidRequest)
	}
	if err := validateToken("protocol", r.Protocol, maxProtocolBytes); err != nil {
		return err
	}
	if len(r.ResolvedIPs) > maxResolvedIPs {
		return fmt.Errorf("%w: resolved_ips exceeds %d entries", ErrInvalidRequest, maxResolvedIPs)
	}
	for i, ip := range r.ResolvedIPs {
		if err := validateToken(fmt.Sprintf("resolved_ips[%d]", i), ip, maxResolvedIPBytes); err != nil {
			return err
		}
	}
	return validateMetadata("session_id", r.SessionID, false)
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

// validateToken requires 1 to maximum bytes without spaces or control
// characters.
func validateToken(name, value string, maximum int) error {
	if value == "" || len(value) > maximum {
		return fmt.Errorf("%w: %s must contain 1 to %d bytes", ErrInvalidRequest, name, maximum)
	}
	if strings.IndexFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return fmt.Errorf("%w: %s contains spaces or control characters", ErrInvalidRequest, name)
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
	cloned.Request.ResolvedIPs = append([]string(nil), envelope.Request.ResolvedIPs...)
	if envelope.Request.Reason != nil {
		reason := *envelope.Request.Reason
		cloned.Request.Reason = &reason
	}
	return cloned
}
