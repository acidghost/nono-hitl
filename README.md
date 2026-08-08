# nono-hitl

`nono-hitl` is a local human-approval backend for [nono](https://github.com/nolabs-ai/nono) command policies. It receives synchronous webhook requests from nono, shows them in a browser outside the wrapped terminal UI, and returns a grant or denial.

The MVP accepts only direct `gh` command approvals. Approval does not construct a sandbox or add privileges: it releases the static delegated-child policy already authored in the nono profile.

## Security status

This service has intentionally **no application authentication**. It is safe only when all of the following are true:

- the service runs as a trusted host process outside the untrusted agent sandbox;
- the agent and every delegated child are unable to connect to `127.0.0.1:8765`;
- the agent is unable to bind port `8765` and impersonate the service;
- the profile contains no localhost allowlisting and no `open_port` or `listen_port` grant for `8765`.

The server refuses non-loopback listeners and binds only literal `127.0.0.1`. Remote and mobile approvals are out of scope.

See [Threat model](#threat-model) before using the service with an agent.

## Quick start

Build and run the service from a trusted host terminal:

```sh
just install
nono-hitl serve --open
```

If the Go bin directory is not already on `PATH`, add the first entry from `go env GOPATH` followed by `/bin`. `just install` honors `go env GOBIN` when it is set and otherwise installs there.

Check the service:

```sh
curl --fail --show-error http://127.0.0.1:8765/healthz
curl --fail --show-error http://127.0.0.1:8765/readyz
```

Then install and compose the profiles in [`examples/README.md`](examples/README.md). A one-shot invocation using the custom local `gh-api` profile is:

```sh
nono run \
  --profile personal \
  --extends gh-approval-profile \
  --extends gh-api \
  --trust-proxy-ca \
  -- gh repo list --visibility private
```

The repository also includes [`examples/gh-api-gh-token-profile.jsonc`](examples/gh-api-gh-token-profile.jsonc), which captures credentials with the official `gh auth token` command. Use installed profile name `gh-api-gh-token` instead of `gh-api` to select it.

For a wrapped agent session:

```sh
nono run \
  --profile personal \
  --extends gh-approval-profile \
  --extends gh-api \
  --trust-proxy-ca \
  -- pi
```

Do not run `nono-hitl` inside that agent sandbox.

## Command-line usage

```text
nono-hitl serve [options]
nono-hitl version
```

Server options:

```text
-listen string
      literal IPv4 loopback address and port (default "127.0.0.1:8765")
-decision-timeout duration
      maximum time to wait for a decision (default 55s)
-open
      open the dashboard in the default browser
```

The listen address must use literal `127.0.0.1`; `localhost`, IPv6 loopback, wildcard addresses, and non-loopback addresses are rejected. Keep the decision timeout below nono's webhook timeout. The supplied profile uses 60 seconds for nono and the service defaults to 55 seconds.

Stopping the process with `SIGINT` or `SIGTERM` denies all pending requests and shuts the HTTP server down gracefully.

## Browser dashboard and notifications

Open <http://127.0.0.1:8765/>. Do not substitute `localhost`: exact `Host` and same-origin checks are intentional.

The dashboard works without browser notifications. To receive them:

1. keep the dashboard open;
2. select **Enable notifications**;
3. authorize notifications in the browser and operating system.

Notification permission requires an explicit browser interaction. If the dashboard is closed, disconnected, denied notification permission, or never opened, the webhook continues waiting and fails closed at its deadline. The absence of a browser never grants a command.

The UI receives lifecycle events over SSE and periodically reconciles an atomic snapshot, so reconnecting does not create a second approval or lose the authoritative state. Recently resolved requests are bounded in memory and disappear when the service restarts.

## Profile wiring

The examples separate two responsibilities:

- [`gh-approval-profile.jsonc`](examples/gh-approval-profile.jsonc) gates direct `gh` invocations and defines the delegated child sandbox;
- a GitHub API profile enables `api.github.com` and supplies a phantom `GH_TOKEN` through nono's proxy.

Two credential routes are documented:

- the user's custom, non-standard `gh-api` profile backed by `gh-auth-cli`;
- the included `gh-api-gh-token` profile backed by the official GitHub CLI.

The real captured token remains in nono's supervisor/proxy and is injected only on the upstream API request. The delegated process receives a phantom value. GitHub App permissions, installation scope, or the permissions of the account token remain the upstream authorization boundary.

The approval profile grants delegated `gh` only:

- read-only access to `$XDG_CONFIG_HOME/gh`;
- mediated access to `api.github.com`;
- a small explicit environment allowlist;
- no localhost connect or bind capability.

Review the complete setup, promotion, acceptance, and audit commands in [`examples/README.md`](examples/README.md).

## Threat model

### Trusted components

- the host user launching `nono-hitl`;
- the nono supervisor and its pre-authored profiles;
- the browser displaying the dashboard;
- host-side credential capture commands.

### Untrusted components

- the wrapped agent and its generated commands;
- all webhook request metadata and command arguments;
- delegated children beyond the exact static capabilities granted by their command policy.

### Authority boundary

The unauthenticated decision API is protected by sandbox reachability, not by a login or bearer token. A process that can connect to the service can submit decisions. A process that can bind the port while the trusted service is absent can impersonate it. Therefore the no-connect and no-bind tests in [`examples/README.md`](examples/README.md) are mandatory acceptance gates.

Browser-origin controls provide defense in depth against cross-origin web pages: decision requests require the exact loopback `Origin`, JSON content type, and exact `Host`; the service emits no CORS permission headers and all GET routes are side-effect free. These controls do not make a localhost-reachable hostile process safe.

Approval releases only the profile's static child sandbox. Request arguments are displayed as untrusted text, never shell-parsed or executed by `nono-hitl`, and rendered through DOM `textContent`. The service accepts only nono command requests for exact command name `gh`; unsupported capabilities and commands fail closed.

### Bounded, fail-closed behavior

- at most 32 requests may be pending;
- at most 100 terminal requests remain in volatile history;
- request bodies, fields, arguments, decision bodies, SSE clients, and subscriber buffers are bounded;
- malformed, oversized, duplicate, late, canceled, unsupported, timed-out, and shutdown requests do not grant execution;
- no approval or application state is written to disk.

### Out of scope

- protection from another malicious process already running with the same host-user authority;
- remote, mobile, or multi-user approvals;
- application authentication or authorization roles;
- persistent history;
- dynamically generated child capabilities;
- native actionable macOS notifications.

## Troubleshooting

### The browser cannot connect

Verify the exact URL and trusted host process:

```sh
curl -v http://127.0.0.1:8765/healthz
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

A request using `localhost`, another address, or a changed `Host` header is rejected. If the port is occupied, identify the listener rather than granting the untrusted agent permission to bind another approval service.

### A request never appears

Confirm `/readyz` succeeds, the profile webhook URL is exactly `http://127.0.0.1:8765/hooks/nono`, and `nono why` reports `APPROVAL REQUIRED` with backend `nono-hitl`. The service must run outside the sandbox while nono's trusted supervisor remains able to reach it.

### The request times out

A missing dashboard or notification does not stop the timer. Open the dashboard and decide within 55 seconds. Keep nono's webhook timeout longer than the service timeout so the service can return an explicit denial first.

### Notifications do not appear

Keep the dashboard tab open, select **Enable notifications**, and inspect browser and macOS notification permissions. Notifications are optional; pending requests remain visible in the dashboard and still fail closed.

### `gh` cannot read its configuration

Check the delegated command's `fs_read` path and the effective `XDG_CONFIG_HOME`. The included approval profile grants read-only `$XDG_CONFIG_HOME/gh`. Do not grant broad Keychain access to the delegated child; credential capture belongs in the trusted supervisor.

### GitHub API requests fail

Verify the selected credential helper directly from a trusted host terminal, redirecting token output to `/dev/null`. Use `--trust-proxy-ca`, confirm `api.github.com` is allowed, and inspect nono's credential-capture audit event. The official-CLI example clears inherited GitHub token variables before calling `gh auth token` so it uses the account stored by `gh auth login`.

### A browser decision returns 403

Decisions require the exact `Origin: http://127.0.0.1:8765` and JSON content type. Use the embedded dashboard rather than weakening origin or CORS checks.

### Running in Docker

The binary can be built as a static Linux image with `just build-image`, but its mandatory literal-loopback binding is inside the container network namespace. Normal port publishing cannot expose that listener. For this local desktop trust boundary, run the binary directly on the host; do not weaken the listener validation for container convenience.

## Development

Development tooling is pinned in [`mise.toml`](mise.toml). `just` is the canonical interface:

```sh
mise install
just fmt
just lint
just vet
just test
just test -race
just build
just build-all
just run --help
```

Run the normal CI-equivalent checks with:

```sh
just check
```

`build-all` cross-compiles static Darwin ARM64 and Linux ARM64/AMD64 binaries. Biome is development tooling only; the embedded dashboard has no runtime JavaScript or CSS dependency downloads.

## License

[The Unlicense](UNLICENSE)
