program := 'nono-hitl'

container_engine := 'docker'
container_registry := 'ghcr.io'
container_image := container_registry + '/acidghost/' + program

webui_dir := 'internal/webui'

install_prefix := `go env GOBIN`

goos := if os() == 'macos' { 'darwin' } else { os() }
goarch := if arch() == 'aarch64' { 'arm64' } else if arch() == 'x86_64' { 'amd64' } else { arch() }
local_binary := 'dist' / program
host_binary := justfile_directory() / local_binary

alias b := build
alias r := run

build-all:
    goreleaser build --snapshot --clean

build-image platform=goarch: (build 'linux' platform)
    {{container_engine}} build --platform 'linux/{{platform}}' -t '{{container_image}}' .

build os=goos arch=goarch:
    GOOS={{os}} GOARCH={{arch}} goreleaser build --snapshot --single-target --clean --output '{{local_binary}}'

run *args: build
    './{{local_binary}}' {{args}}

# serves the UI from disk while bun rebuilds it on every change; refresh the browser to see it
dev *args: web
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    (cd {{webui_dir}} && bun run build:app --watch) &
    (cd {{webui_dir}} && bun run build:theme --watch) &
    go run -tags dev . serve {{args}}

vendor:
    go mod tidy
    go mod vendor

fmt:
    golangci-lint fmt
    biome format --write {{webui_dir}}

lint: web
    golangci-lint run
    biome check {{webui_dir}}
    @if grep -rnE 'innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML' {{webui_dir}}/src; then \
        echo 'render untrusted values as text, not HTML' >&2; exit 1; fi

test *args: web
    go test {{args}} ./...

vet: web
    go vet ./...

web-install:
    cd {{webui_dir}} && bun install --frozen-lockfile

web: web-install
    cd {{webui_dir}} && bun run build

typecheck: web-install
    cd {{webui_dir}} && bunx tsc --noEmit

web-test *args: web-install
    cd {{webui_dir}} && bun test {{args}}

_browser: web-install
    cd {{webui_dir}} && ./node_modules/.bin/playwright install chromium

e2e *args: _browser build typecheck
    cd {{webui_dir}} && NONO_HITL_BIN='{{host_binary}}' bunx playwright test --project e2e {{args}}

# local screenshot diffs, never run in CI; --update-snapshots retakes the baselines
screenshots *args: _browser build typecheck
    cd {{webui_dir}} && NONO_HITL_BIN='{{host_binary}}' bunx playwright test --project light --project dark {{args}}

check: lint typecheck web-test vet test build

release-check:
    goreleaser check

release-snapshot:
    goreleaser release --snapshot --clean --skip=publish

release:
    goreleaser release --clean

install: build
    cp -v '{{local_binary}}' "{{install_prefix}}/{{program}}"

clean:
    rm -rf dist {{webui_dir}}/dist

help:
    @just --list
