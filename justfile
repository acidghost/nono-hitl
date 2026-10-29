program := 'nono-hitl'

version := 'SNAPSHOT-'+`git describe --tags --always --dirty 2>/dev/null || printf 'unknown'`
commit_sha := `(git rev-parse HEAD 2>/dev/null || printf 'unknown') | tr -d '\n'`
build_time := `date -u '+%Y-%m-%d_%H:%M:%S'`

container_engine := 'docker'
container_registry := 'ghcr.io'
container_image := container_registry + '/acidghost/' + program

webui_dir := 'internal/webui'

ldflags := '-s -w -X main.buildVersion='+version \
        +' -X main.buildCommit='+commit_sha \
        +' -X main.buildDate='+build_time

install_prefix := `go env GOBIN`

goos := if os() == 'macos' { 'darwin' } else { os() }
goarch := if arch() == 'aarch64' { 'arm64' } else if arch() == 'x86_64' { 'amd64' } else { arch() }
host_binary := justfile_directory() / 'build' / program + '-' + goos + '-' + goarch

alias b := build
alias r := run

build-all: (build 'darwin' 'arm64') (build 'linux' 'arm64') (build 'linux' 'amd64')

build-image platform=goarch:
    {{container_engine}} build \
        --platform 'linux/{{platform}}' \
        --build-arg BUILD_VERSION='{{version}}' \
        --build-arg BUILD_COMMIT='{{commit_sha}}' \
        -t '{{container_image}}' .

build os=goos arch=goarch: build-dir web
    CGO_ENABLED=0 GOOS={{os}} GOARCH={{arch}} \
        go build \
            -ldflags '{{ldflags}}' \
            -o build/{{program}}-{{os}}-{{arch}}

build-dir:
    mkdir -p build

run *args: build
    ./build/{{program}}-{{goos}}-{{goarch}} {{args}}

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

install: build
    cp -v './build/{{program}}-{{goos}}-{{goarch}}' "{{install_prefix}}/{{program}}"

clean:
    rm -rf build {{webui_dir}}/dist

help:
    @just --list
