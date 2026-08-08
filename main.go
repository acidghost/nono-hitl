package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/acidghost/nono-hitl/internal/approval"
	"github.com/acidghost/nono-hitl/internal/browser"
	"github.com/acidghost/nono-hitl/internal/server"
)

var (
	buildVersion string
	buildCommit  string
	buildDate    string
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "nono-hitl: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		printUsage(stdout)
		return nil
	}

	switch args[0] {
	case "serve":
		return runServe(args[1:], stdout, stderr)
	case "version", "--version":
		printVersion(stdout)
		return nil
	case "help", "-h", "--help":
		printUsage(stdout)
		return nil
	default:
		return fmt.Errorf("unknown command %q (try --help)", args[0])
	}
}

func runServe(args []string, stdout, stderr io.Writer) error {
	config := server.DefaultConfig()
	openDashboard := false
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(
		&config.ListenAddress,
		"listen",
		config.ListenAddress,
		"literal IPv4 loopback address and port",
	)
	flags.DurationVar(
		&config.DecisionTimeout,
		"decision-timeout",
		config.DecisionTimeout,
		"maximum time to wait for a decision",
	)
	flags.BoolVar(
		&openDashboard,
		"open",
		openDashboard,
		"open the dashboard in the default browser",
	)
	flags.Usage = func() {
		_, _ = fmt.Fprintln(stderr, "Usage: nono-hitl serve [options]")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return fmt.Errorf("parse serve options: %w", err)
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("serve does not accept positional arguments")
	}

	store, err := approval.NewStore(approval.StoreConfig{
		MaxPending: 32,
		MaxRecent:  100,
	})
	if err != nil {
		return fmt.Errorf("create approval store: %w", err)
	}
	service, err := server.New(config, store)
	if err != nil {
		return fmt.Errorf("configure server: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if openDashboard {
		go func() {
			select {
			case <-service.Listening():
				if openErr := browser.Open(service.URL()); openErr != nil {
					_, _ = fmt.Fprintf(stderr, "nono-hitl: could not open dashboard: %v\n", openErr)
				}
			case <-ctx.Done():
			}
		}()
	}
	_, _ = fmt.Fprintf(stdout, "nono-hitl listening on %s\n", service.URL())
	if err := service.Run(ctx); err != nil {
		return err
	}
	return nil
}

func printUsage(writer io.Writer) {
	_, _ = fmt.Fprintln(writer, `Usage: nono-hitl <command>

Commands:
  serve       Run the local approval HTTP service
  version     Print build information

Run "nono-hitl serve --help" for server options.`)
}

func printVersion(writer io.Writer) {
	version := valueOrUnknown(buildVersion)
	commit := valueOrUnknown(buildCommit)
	date := valueOrUnknown(buildDate)
	_, _ = fmt.Fprintf(writer, "Version: %s\nCommit:  %s\nDate:    %s\n", version, commit, date)
}

func valueOrUnknown(value string) string {
	if value == "" {
		return "unknown"
	}
	return value
}
