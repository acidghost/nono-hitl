package approval

import (
	"errors"
	"strings"
	"testing"
)

func TestDecodeWebhookCommand(t *testing.T) {
	t.Parallel()

	payload := `{
		"backend":"nono-hitl",
		"future_envelope_field":true,
		"request":{
			"capability_type":"command",
			"request_id":"req-1",
			"command":"gh",
			"args":["gh","issue","view","123"],
			"caller":"session",
			"intercept_rule":"invocation_policy.default",
			"reason":"Inspect an issue",
			"child_pid":1234,
			"session_id":"session-1",
			"future_request_field":{"nested":true}
		}
	}`

	envelope, err := DecodeWebhook(strings.NewReader(payload))
	if err != nil {
		t.Fatalf("DecodeWebhook() error = %v", err)
	}
	if envelope.Backend != "nono-hitl" {
		t.Fatalf("Backend = %q, want nono-hitl", envelope.Backend)
	}
	if envelope.Request.RequestID != "req-1" {
		t.Fatalf("RequestID = %q, want req-1", envelope.Request.RequestID)
	}
	if envelope.Request.Reason == nil || *envelope.Request.Reason != "Inspect an issue" {
		t.Fatalf("Reason = %v, want Inspect an issue", envelope.Request.Reason)
	}
	if got := len(envelope.Request.Args); got != 4 {
		t.Fatalf("len(Args) = %d, want 4", got)
	}
}

func TestDecodeWebhookRejectsUnsupportedCapability(t *testing.T) {
	t.Parallel()

	payload := `{"backend":"nono-hitl","request":{"capability_type":"network","request_id":"req-1"}}`
	_, err := DecodeWebhook(strings.NewReader(payload))
	if !errors.Is(err, ErrUnsupportedCapability) {
		t.Fatalf("error = %v, want ErrUnsupportedCapability", err)
	}
}

func TestDecodeWebhookRejectsUnsupportedCommand(t *testing.T) {
	t.Parallel()

	payload := validPayload(`"command":"git"`)
	_, err := DecodeWebhook(strings.NewReader(payload))
	if !errors.Is(err, ErrUnsupportedCommand) {
		t.Fatalf("error = %v, want ErrUnsupportedCommand", err)
	}
}

func TestDecodeWebhookRejectsInvalidRequests(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"malformed JSON":       `{`,
		"multiple JSON values": validPayload(`"command":"gh"`) + `{}`,
		"missing backend":      strings.Replace(validPayload(`"command":"gh"`), `"backend":"nono-hitl",`, "", 1),
		"missing request ID":   strings.Replace(validPayload(`"command":"gh"`), `"request_id":"req-1"`, `"request_id":""`, 1),
		"missing arguments":    strings.Replace(validPayload(`"command":"gh"`), `"args":["gh","status"]`, `"args":[]`, 1),
		"missing caller":       strings.Replace(validPayload(`"command":"gh"`), `"caller":"session"`, `"caller":""`, 1),
		"missing rule":         strings.Replace(validPayload(`"command":"gh"`), `"intercept_rule":"default"`, `"intercept_rule":""`, 1),
		"missing session":      strings.Replace(validPayload(`"command":"gh"`), `"session_id":"session-1"`, `"session_id":""`, 1),
		"oversized request ID": strings.Replace(validPayload(`"command":"gh"`), `"req-1"`, strings.Repeat("r", maxRequestIDBytes+1), 1),
		"oversized argument":   strings.Replace(validPayload(`"command":"gh"`), `"status"`, strings.Repeat("a", maxArgumentBytes+1), 1),
	}

	for name, payload := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := DecodeWebhook(strings.NewReader(payload))
			if !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("error = %v, want ErrInvalidRequest", err)
			}
		})
	}
}

func TestCommandRequestValidateBoundsArgumentCountAndTotalSize(t *testing.T) {
	t.Parallel()

	request := testEnvelope("req-1").Request
	request.Args = make([]string, maxArguments+1)
	if err := request.Validate(); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("argument count error = %v, want ErrInvalidRequest", err)
	}

	request = testEnvelope("req-2").Request
	request.Args = make([]string, maxArguments)
	for i := range request.Args {
		request.Args[i] = strings.Repeat("a", maxArgumentsBytes/maxArguments+1)
	}
	if err := request.Validate(); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("total argument size error = %v, want ErrInvalidRequest", err)
	}
}

func validPayload(commandField string) string {
	return `{
		"backend":"nono-hitl",
		"request":{
			"capability_type":"command",
			"request_id":"req-1",
			` + commandField + `,
			"args":["gh","status"],
			"caller":"session",
			"intercept_rule":"default",
			"reason":null,
			"child_pid":1234,
			"session_id":"session-1"
		}
	}`
}

func testEnvelope(requestID string) WebhookEnvelope {
	reason := "Needed for the requested task"
	return WebhookEnvelope{
		Backend: "nono-hitl",
		Request: CommandRequest{
			CapabilityType: CapabilityCommand,
			RequestID:      requestID,
			Command:        SupportedCommand,
			Args:           []string{"gh", "status"},
			Caller:         "session",
			InterceptRule:  "invocation_policy.default",
			Reason:         &reason,
			ChildPID:       1234,
			SessionID:      "session-1",
		},
	}
}
