// Package classifier asks a local Ollama decision model about command
// requests. Each entry attaches a question to a command prefix.
package classifier

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
)

const (
	maxPrefixTokens = 16
	maxAskBytes     = 4 * 1024
)

// Mode says what the model's answer does to a request.
type Mode string

// ModeAdvise shows the answer on the request card and decides nothing.
const ModeAdvise Mode = "advise"

// Entry attaches an ask to every request whose argv starts with Prefix. The
// model answers the ask with the probability that it is true, and the
// request passes when that is at most MaxRisk.
type Entry struct {
	Prefix  []string `json:"prefix"`
	Ask     string   `json:"ask"`
	Model   string   `json:"model"`
	MaxRisk float64  `json:"max_risk"`
	Mode    Mode     `json:"mode"`
}

// Validate checks the bounds of one entry.
func (e Entry) Validate() error {
	if len(e.Prefix) == 0 || len(e.Prefix) > maxPrefixTokens {
		return fmt.Errorf("prefix must contain 1 to %d tokens", maxPrefixTokens)
	}
	// The dashboard splits prefixes on spaces, so a token holding one would
	// come back from it as two.
	if slices.ContainsFunc(e.Prefix, func(token string) bool {
		return token == "" || strings.ContainsFunc(token, unicode.IsSpace)
	}) {
		return errors.New("prefix tokens must not be empty or contain spaces")
	}
	if strings.TrimSpace(e.Ask) == "" || len(e.Ask) > maxAskBytes {
		return fmt.Errorf("ask must contain 1 to %d bytes", maxAskBytes)
	}
	if strings.TrimSpace(e.Model) == "" {
		return errors.New("model is required")
	}
	// Written this way round so NaN fails too.
	if !(e.MaxRisk >= 0 && e.MaxRisk <= 1) {
		return errors.New("max_risk must be between 0 and 1")
	}
	if e.Mode != ModeAdvise {
		return fmt.Errorf("mode must be %q", ModeAdvise)
	}
	return nil
}

// Match returns the entry with the longest prefix matching the request. The
// first token matches command, the rest match args[1:], since args[0] may be
// a path.
func Match(entries []Entry, command string, args []string) (Entry, bool) {
	var best Entry
	matched := false
	for _, entry := range entries {
		if matches(entry.Prefix, command, args) && (!matched || len(entry.Prefix) > len(best.Prefix)) {
			best, matched = entry, true
		}
	}
	return best, matched
}

func matches(prefix []string, command string, args []string) bool {
	if len(prefix) == 0 || prefix[0] != command || len(args) < len(prefix) {
		return false
	}
	for i, token := range prefix[1:] {
		if args[i+1] != token {
			return false
		}
	}
	return true
}
