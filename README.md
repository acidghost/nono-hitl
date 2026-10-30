# nono-hitl

<img src="internal/webui/logo.svg" alt="nono-hitl logo" width="96" height="96">

`nono-hitl` is a local human-approval backend for
[nono](https://github.com/nolabs-ai/nono) command policies. It receives
synchronous webhook requests from nono, shows them in a browser outside the
wrapped terminal UI, and returns a grant or denial.

The service accepts command approvals for any program. Approval does not
construct a sandbox or add privileges: it releases the static delegated-child
policy already authored in the nono profile.

## Security status

This service has intentionally **no application authentication**. It is safe
only when all of the following are true:

- the service runs as a trusted host process outside the untrusted agent
  sandbox;
- the agent and every delegated child are unable to connect to `127.0.0.1:8765`;
- the agent is unable to bind port `8765` and impersonate the service;
- the effective composed profile contains no localhost allowlisting and no
  `open_port` or `listen_port` grant for `8765`.

The server refuses non-loopback listeners and binds only literal `127.0.0.1`.
Remote and mobile approvals are out of scope.

See [Threat model](#threat-model) before using the service with an agent.

## Quick start

Build and run the service from a trusted host terminal. The build needs Go, bun
and just; `mise install` sets up the versions pinned in
[`mise.toml`](mise.toml).

```sh
just install
nono-hitl serve --open
```

If the Go bin directory is not already on `PATH`, add the first entry from
`go env GOPATH` followed by `/bin`. `just install` honors `go env GOBIN` when it
is set and otherwise installs there.

Check the service:

```sh
curl --fail --show-error http://127.0.0.1:8765/healthz
curl --fail --show-error http://127.0.0.1:8765/readyz
```

Install and promote the included approval profile:

```sh
mkdir -p ~/.config/nono/profile-drafts
cp examples/gh-approval-profile.jsonc \
  ~/.config/nono/profile-drafts/gh-approval.json
nono profile validate --strict --draft gh-approval
nono profile promote gh-approval
```

Run it alongside an existing base profile (replace `personal` with your profile
name):

```sh
nono run \
  --profile personal \
  --extends gh-approval \
  --trust-proxy-ca \
  -- gh repo list --visibility private
```

To wrap an agent instead, replace the trailing command with `-- pi`. Keep
`nono-hitl` running in a trusted host terminal, outside the agent sandbox.

## Run at login on macOS

The included LaunchAgent runs `nono-hitl serve` as your normal user, outside the
agent sandbox. Run the installation script from a trusted host terminal after
installing the binary and adding it to `PATH`:

```sh
./examples/install-launchagent.sh
```

The script installs `examples/nono-hitl.plist`, fills in absolute binary and log
paths, validates it, and loads the service. If already loaded, unload it using
the command below before running the script again.

Stop any manually started instance first to free port `8765`. The LaunchAgent
starts immediately and at login, and restarts the service if it exits. No `sudo`
is needed. launchd requires an absolute binary path; it does not expand `~` or
use your shell's `PATH`. If you move the binary, update the plist and reload it.
Open <http://127.0.0.1:8765/> manually when needed.

Standard output and errors are appended to separate files under
`~/Library/Logs/nono-hitl/`. To follow both:

```sh
tail -F "$HOME/Library/Logs/nono-hitl/stdout.log" "$HOME/Library/Logs/nono-hitl/stderr.log"
```

launchd does not rotate these logs automatically.

To stop and unload the service:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/nono-hitl.plist"
```

Remove that plist to prevent it from starting at future logins.

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
-nono-state-dir string
      nono state directory holding the session records
      (default "$XDG_STATE_HOME/nono" or "~/.local/state/nono")
-config string
      config file
      (default "$XDG_CONFIG_HOME/nono-hitl/config.json" or
      "~/.config/nono-hitl/config.json")
```

The listen address must use literal `127.0.0.1`; `localhost`, IPv6 loopback,
wildcard addresses, and non-loopback addresses are rejected. Keep the decision
timeout below nono's webhook timeout. The supplied profile uses 60 seconds for
nono and the service defaults to 55 seconds.

The state directory follows nono's own rule: `$XDG_STATE_HOME/nono` when that
variable holds an absolute path, `~/.local/state/nono` otherwise. Set
`-nono-state-dir` only if nono runs with a different `XDG_STATE_HOME` than the
service.

The config file is `$XDG_CONFIG_HOME/nono-hitl/config.json` when that variable
holds an absolute path, `~/.config/nono-hitl/config.json` otherwise. The service
reads it at startup, so restart it after a hand edit. A missing file leaves
every setting at its default, which means no classifiers. An invalid one,
unknown fields included, stops the service from starting. Saving from the
[Config view](#browser-dashboard-and-notifications) rewrites the file, dropping
hand edits made since the service started. [`config.json`](examples/config.json)
is a starting point, and the [command classifier](#command-classifier) section
explains its fields.

Stopping the process with `SIGINT` or `SIGTERM` denies all pending requests and
shuts the HTTP server down gracefully.

## Browser dashboard and notifications

Open <http://127.0.0.1:8765/>. Do not substitute `localhost`: exact `Host` and
same-origin checks are intentional.

The dashboard has four views. **Pending** shows waiting requests as tabs above
the request card, with the decision buttons right below the arguments.
**Sessions** lists session approvals grouped by nono session, and **History**
lists recent decisions; select one to open its card with the final outcome.
**Config** shows the config file's `ollama_url` and edits its
[command classifiers](#command-classifier). Approval does not report whether the
command executed successfully. Decisions are disabled while disconnected, until
the request state is reconciled, and once the deadline has passed.

**Deny with note** sends a note with the denial. nono puts the denial reason in
the error the agent gets for the blocked command, so a note such as "use gh pr
view instead" tells it what to do next. nono replaces control characters with
spaces, so the note stays on one line.

Everything can be done from the keyboard; press `?` for the shortcuts, the theme
selector, and a switch that turns shortcuts off. Approve keys are guarded: they
work only one second after a request is shown or the window gains focus, and
only after a short pause in typing, so text meant for a terminal cannot approve
anything.

The dashboard works without browser notifications. To receive them:

1. keep the dashboard open;
2. select **Enable notifications**;
3. authorize notifications in the browser and operating system.

Notification permission requires an explicit browser interaction. If the
dashboard is closed, disconnected, denied notification permission, or never
opened, the webhook continues waiting and fails closed at its deadline. The
absence of a browser never grants a command.

### Session approvals

**Approve for session** grants the request and also grants later requests from
the same nono session whose command, argument array, caller, and rule match it
exactly. Matching requests already waiting are granted at once. The session is
the `session_id` nono's supervisor reports for each `nono run`, so a new run
starts without session approvals.

The dashboard names each session from the record nono keeps under `sessions/` in
its state directory, showing the agent and working directory too. Without a
record it shows the session ID. Every 30 seconds the service revokes session
approvals whose record says the session exited. A missing record keeps them.
Otherwise approvals stay in memory until revoked from the dashboard, evicted
(oldest first, at most 64), or the service restarts. Requests released this way
appear in History, and each approval counts them.

Exactness covers only what nono reports: nono omits arguments that are not valid
UTF-8 from the request, so two invocations differing only in such an argument
look identical.

The UI receives lifecycle events over SSE and periodically reconciles an atomic
snapshot, so reconnecting does not create a second approval or lose the
authoritative state. Recently resolved requests are bounded in memory and
disappear when the service restarts.

### Command classifier

A classifier attaches a question, the ask, to every request whose arguments
start with a given prefix. While the request waits, `nono-hitl` sends the
command and its arguments to a local [Ollama](https://ollama.com) decision model
and shows the answer on the request card. The model decides nothing: the request
waits for a human either way.

Classifiers live in the [config file](#command-line-usage), next to the
`ollama_url` they call:

```json
{
  "ollama_url": "http://127.0.0.1:11434",
  "classifiers": [
    {
      "prefix": ["docker"],
      "ask": "Is this docker command dangerous or risky?",
      "model": "d3",
      "max_risk": 0.3,
      "mode": "advise"
    },
    {
      "prefix": ["docker", "run"],
      "ask": "Does this docker run command mount host paths, use host namespaces or run privileged?",
      "model": "d3",
      "max_risk": 0.2,
      "mode": "advise"
    }
  ]
}
```

- `prefix` matches whole tokens. The first one matches the command name nono
  reports, the others the arguments after the program, so `docker` doesn't match
  `dockerd`. The longest matching prefix wins: `docker run` gets the second ask
  and `docker ps` the first. Tokens can't contain spaces.
- The model answers the `ask` with the probability that it is true. Phrase it so
  true means risky. The request looks safe when the answer is at most
  `max_risk`.
- `model` must be a decision model, one Ollama serves on `/v1/systemone`.
- `mode` is required. `advise` is the only mode for now.
- `ollama_url` is optional and defaults to `http://127.0.0.1:11434`. The command
  and arguments of every matching request go there.

The card shows **Classifying…** until the model answers, then **Looks safe** or
**Looks risky** with the answer against `max_risk`. A call that fails or takes
longer than 15 seconds shows **Unavailable** and the reason, which also goes to
stderr. Advice arriving re-arms the approve buttons. Requests released by a
session approval skip the model, and History keeps the advice of the others.

The **Config** view edits the same list. Changes stay in the browser until
**Save** sends the whole list. The service checks it as it checks the file at
startup, writes the file with mode 0600 through a temporary file and a rename,
and only then uses the new entries. A request already waiting keeps the advice
it got. The view shows `ollama_url` but can't change it: only a hand edit of the
file changes where arguments go.

To try an ask, give the model the JSON `nono-hitl` sends:

```sh
echo '{"command":"docker","args":["docker","run","-v","/:/host","alpine"]}' |
  ollama run d3 --ask "Is this docker command dangerous or risky?"
```

## Profile wiring

`nono-hitl` does not restrict the program named by a command request; nono's
pre-authored command policy remains the authority boundary. The included
[`gh-approval-profile.jsonc`](examples/gh-approval-profile.jsonc) is a
composable profile overlay for `gh`:

- common read-only `gh` subcommands are allowed without a prompt; other direct
  `gh` invocations request approval through `nono-hitl`;
- after approval, nono runs `gh` in a delegated sandbox with scoped filesystem,
  environment, and `api.github.com` access, and separately constrains its `git`
  child process;
- nono runs the configured `gh auth token` command on the trusted host and
  injects its output through the API proxy. The delegated process receives a
  phantom `GH_TOKEN`, not the real token.

Approval gates each command invocation, not individual API operations. An
approved `gh` command can use the configured `api.github.com` credential route;
the token's GitHub permissions remain the operation-level authorization
boundary. Ensure `gh auth token` succeeds on the host. Use `--trust-proxy-ca`
when running the composed profile so `gh` trusts nono's intercepted TLS
connection.

## Threat model

### Trusted components

- the host user launching `nono-hitl`;
- the nono supervisor and its pre-authored profiles;
- the browser displaying the dashboard;
- host-side credential capture commands;
- the config file, the Ollama instance at `ollama_url`, and its models.

### Untrusted components

- the wrapped agent and its generated commands;
- all webhook request metadata and command arguments;
- delegated children beyond the exact static capabilities granted by their
  command policy.

### Authority boundary

The unauthenticated decision API is protected by sandbox reachability, not by a
login or bearer token. A process that can connect to the service can submit
decisions and replace the classifiers. A process that can bind the port while
the trusted service is absent can impersonate it. Before use, verify that
neither the agent session nor its delegated children can connect to the service
or bind its port; inspect the effective composed profile, not just the example
overlay.

Browser-origin controls provide defense in depth against cross-origin web pages:
decision and config requests require the exact loopback `Origin`, JSON content
type, and exact `Host`; the service emits no CORS permission headers and all GET
routes are side-effect free. These controls do not make a localhost-reachable
hostile process safe.

Approval releases only the profile's static child sandbox. Request arguments are
displayed as untrusted text, never shell-parsed or executed by `nono-hitl`, and
rendered through DOM `textContent`. The service accepts nono command requests
for any non-empty command name; unsupported capability types fail closed.

The service reads nono's session records from the state directory. Session IDs
are checked against nono's ID rule before building a path, and symlinks,
non-regular files and records over 64 KiB are refused. Names, agents and
directories from a record are display labels: session approvals match on the
session ID in the request. A record can only remove approvals, by saying its
session exited.

Classifier advice is only as good as Ollama and the config file. Anything that
can reach Ollama's port can replace or delete the model behind a name, so the
agent and its delegated children must not reach `127.0.0.1:11434` or write to
`~/.ollama`. They must not be able to write the config file either: with it, the
agent could raise `max_risk` or remove an entry. Command arguments are untrusted
input to the model, and text in them can lower the risk it reports. Read the
advice as a hint, never as a reason to skip reading the request.

### Bounded, fail-closed behavior

- at most 32 requests may be pending;
- at most 100 terminal requests remain in volatile history;
- at most 64 session approvals are kept; the oldest is evicted first;
- request bodies, fields, arguments, decision bodies, SSE clients, and
  subscriber buffers are bounded;
- each classifier call is bounded at 15 seconds and a 64 KiB response, and its
  answer never decides a request;
- malformed, oversized, duplicate, late, canceled, unsupported, timed-out, and
  shutdown requests do not grant execution;
- no approval state is written to disk. The one file the service writes is the
  config file, when the Config view saves.

### Out of scope

- protection from another malicious process already running with the same
  host-user authority;
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

A request using `localhost`, another address, or a changed `Host` header is
rejected. If the port is occupied, identify the listener rather than granting
the untrusted agent permission to bind another approval service.

### A request never appears

Confirm `/readyz` succeeds, the profile webhook URL is exactly
`http://127.0.0.1:8765/hooks/nono`, and `nono why` reports `APPROVAL REQUIRED`
with backend `nono-hitl`. The service must run outside the sandbox while nono's
trusted supervisor remains able to reach it.

### The request times out

A missing dashboard or notification does not stop the timer. Open the dashboard
and decide within 55 seconds. Keep nono's webhook timeout longer than the
service timeout so the service can return an explicit denial first.

### The card says Unavailable

The reason comes from the call to Ollama. Check that Ollama runs at
`ollama_url`, that `ollama list` shows the model, and that the same ask works
with `ollama run MODEL --ask`. Ollama refuses models that aren't decision
models. The first call after Ollama unloads a model can take several seconds.

### Notifications do not appear

Keep the dashboard tab open, select **Enable notifications**, and inspect
browser and macOS notification permissions. Notifications are optional; pending
requests remain visible in the dashboard and still fail closed.

### `gh` cannot read its configuration

Check the delegated command's `fs_read` paths and the effective
`XDG_CONFIG_HOME`. The included approval profile grants read access to the
current directory and `$XDG_CONFIG_HOME/gh`. Do not grant broad Keychain access
to the delegated child; credential capture belongs in the trusted supervisor.

### GitHub API requests fail

Confirm `gh auth token` succeeds from a trusted terminal, redirecting its output
to `/dev/null`. Use `--trust-proxy-ca`, confirm `api.github.com` is allowed, and
inspect nono's credential-capture audit event. The example runs `gh auth token`
through nono's supervisor-side credential capture; the real token is not passed
to the child.

### A browser decision returns 403

Decisions and config saves require the exact `Origin: http://127.0.0.1:8765` and
JSON content type. Use the embedded dashboard rather than weakening origin or
CORS checks.

### Running in Docker

The binary can be built as a static Linux image with `just build-image`, but its
mandatory literal-loopback binding is inside the container network namespace.
Normal port publishing cannot expose that listener. For this local desktop trust
boundary, run the binary directly on the host; do not weaken the listener
validation for container convenience.

## Development

Development tooling is pinned in [`mise.toml`](mise.toml). `just` is the
canonical interface:

```sh
mise install
just fmt
just lint
just vet
just test
just test -race
just web-test
just build
just build-all
just run --help
```

Run the normal CI-equivalent checks with:

```sh
just check
```

`build-all` cross-compiles static Darwin ARM64 and Linux ARM64/AMD64 binaries.

The dashboard is Preact components written in TSX, in `internal/webui/src`. bun
bundles them into `internal/webui/dist`, which the binary embeds, so every
recipe that compiles Go runs `just web` first. The page loads nothing from
outside the binary. `just web-test` runs the unit tests for its pure helpers.

`just dev` runs the server from source with the dashboard read from disk, while
bun rebuilds it on every change. Refresh the browser to see an edit; pending
requests survive because the server keeps running.

The browser tests in `internal/webui/e2e` drive the dashboard in Chromium
against a fresh binary, one server per test, and check the decision nono
receives. CI runs them too. Both recipes install Chromium on first use:

```sh
just e2e
just screenshots
```

`just screenshots` compares light and dark screenshots of the main dashboard
states with local baselines that stay out of git. Take them on a known-good
commit with `just screenshots --update-snapshots`.

To try the dashboard by hand, run `just run serve -config examples/config.json`
and send requests with [`send-request.sh`](examples/send-request.sh).

## License

[The Unlicense](UNLICENSE)
