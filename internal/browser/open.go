// Package browser opens the local dashboard without invoking a shell.
package browser

import (
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
)

// Open launches dashboardURL in the platform's default browser.
func Open(dashboardURL string) error {
	parsed, err := url.Parse(dashboardURL)
	if err != nil {
		return fmt.Errorf("parse dashboard URL: %w", err)
	}
	if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.User != nil {
		return errors.New("dashboard URL must use plain HTTP on literal 127.0.0.1")
	}
	port, portErr := strconv.ParseUint(parsed.Port(), 10, 16)
	if portErr != nil || port == 0 || parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("dashboard URL must contain only a loopback port and root path")
	}

	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		// dashboardURL is constrained above and is passed as an argv token, not shell input.
		command = exec.Command("/usr/bin/open", dashboardURL) //nolint:gosec
	case "linux":
		executable, lookupErr := exec.LookPath("xdg-open")
		if lookupErr != nil {
			return errors.New("xdg-open is unavailable")
		}
		// Both executable and dashboardURL are constrained above; no shell is involved.
		command = exec.Command(executable, dashboardURL) //nolint:gosec
	default:
		return fmt.Errorf("opening a browser is unsupported on %s", runtime.GOOS)
	}
	if err := command.Run(); err != nil {
		return fmt.Errorf("open default browser: %w", err)
	}
	return nil
}
