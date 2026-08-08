# Testing the composable `gh` approval profile

`gh-approval-profile.jsonc` is an approval overlay. It deliberately has no `extends` field and does not define GitHub credentials. Compose it with a base sandbox and a separate GitHub API credential profile.

This repository includes `gh-api-gh-token-profile.jsonc`, which captures the logged-in user's token with the official GitHub CLI. Its effective credential command is:

```sh
gh auth token --hostname github.com
```

The profile invokes it through `/usr/bin/env -u ...` to clear `GH_TOKEN`, `GITHUB_TOKEN`, and their Enterprise variants first. The current `gh` otherwise returns an inherited environment token even when `auth token` is used, which would select launcher state instead of the account stored by `gh auth login`.

The separately installed `gh-api` profile used in the examples below is a user-defined profile, not a standard profile shipped by nono or this repository. It has equivalent API proxy configuration but captures a GitHub App user token with `gh-auth-cli`:

```sh
gh-auth-cli token --non-interactive --min-validity 20m
```

The example intentionally has no `$schema` declaration. nono's checked-in schema can lag the implementation; the current Rust profile structs, validation code, and proxy runtime are the source of truth. The fields in this example were checked against those implementations rather than inferred from the generated schema.

Choose one credential profile:

| Installed profile | Capture command | Credential source |
|---|---|---|
| `gh-api` | `gh-auth-cli token --non-interactive --min-validity 20m` | Custom GitHub App configured through `gh-auth-cli` |
| `gh-api-gh-token` | `/usr/bin/env -u … gh auth token --hostname github.com` | Account logged in through the official `gh` CLI |

Both use nono's `cmd://github` capture. The command runs lazily in the trusted supervisor, the real token remains in the in-memory broker/proxy, and the sandboxed process receives only a phantom `GH_TOKEN`. The proxy injects the real token when forwarding requests to `api.github.com`.

The composed flow is:

1. nono intercepts a direct `gh` invocation and waits for `nono-hitl`.
2. After approval, nono launches `gh` in the static child sandbox.
3. On the first matching API request, the chosen profile captures a token outside the untrusted child.
4. nono mediates `api.github.com` and injects the captured credential upstream.

The approval overlay admits the phantom `GH_TOKEN` into the delegated `gh` child. Do not compose it with a profile that passes an unmediated raw `GH_TOKEN` from the launcher.

The profile intentionally grants neither `network.open_port` nor `network.listen_port`. Do not add either grant for port `8765` to an untrusted agent profile. A connect grant permits self-approval; a listen grant permits approval-service impersonation when the real service is absent.

## Prerequisites

- nono `0.72.0`
- official `gh` installed
- a user profile named `personal`
- two ordinary host Terminal windows
- one configured credential provider described below

### Option 1: custom `gh-api` with `gh-auth-cli`

The `gh-api` profile is local user configuration and must already be installed. `gh-auth-cli` must be on the supervisor's `PATH`, configured, and logged in.

Check it from a trusted host terminal:

```sh
command -v gh-auth-cli
gh-auth-cli status
gh-auth-cli token --non-interactive --min-validity 20m >/dev/null
```

The final command must succeed without printing the token. The custom GitHub App's permissions and installation scope remain the upstream authorization boundary.

### Option 2: included profile with official `gh`

The official CLI must already be logged in to `github.com` on the host:

```sh
command -v gh
gh auth status --hostname github.com
/usr/bin/env \
  -u GH_TOKEN -u GITHUB_TOKEN \
  -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  gh auth token --hostname github.com >/dev/null
```

The final command must succeed without printing the token. Depending on the host's `gh` configuration, supervisor-side capture may need access to the GitHub CLI config and the operating-system credential store. This access belongs only to the trusted capture process; do not grant broad Keychain access to the delegated `gh` child.

Validate and install the included credential overlay:

```sh
nono profile validate --strict ./examples/gh-api-gh-token-profile.jsonc
cp ./examples/gh-api-gh-token-profile.jsonc \
  ~/.config/nono/profile-drafts/gh-api-gh-token.json
nono profile validate --strict --draft gh-api-gh-token
nono profile promote gh-api-gh-token
```

Both credential profiles allow the whole `api.github.com` host. Add endpoint restrictions to the chosen profile if its consumers require a narrower API surface.

## 1. Validate and install the approval overlay

From the `nono-hitl` checkout:

```sh
nono profile validate --strict ./examples/gh-approval-profile.jsonc
```

For a new installation:

```sh
cp ./examples/gh-approval-profile.jsonc \
  ~/.config/nono/profile-drafts/gh-approval-profile.json
nono profile validate --strict --draft gh-approval-profile
nono profile promote gh-approval-profile
```

If `~/.config/nono/profiles/gh-approval-profile.json` already exists, create the required draft base hash before copying the update:

```sh
shasum -a 256 ~/.config/nono/profiles/gh-approval-profile.json |
  awk '{print $1}' > \
  ~/.config/nono/profile-drafts/gh-approval-profile.base
cp ./examples/gh-approval-profile.jsonc \
  ~/.config/nono/profile-drafts/gh-approval-profile.json
nono profile validate --strict --draft gh-approval-profile
nono profile promote --diff gh-approval-profile
nono profile promote gh-approval-profile
```

Check the composed command policy using the credential profile you selected:

```sh
nono why \
  --profile personal \
  --extends gh-approval-profile \
  --extends gh-api \
  --command gh -- repo list --visibility private
```

To use the included official-CLI variant, replace `gh-api` with `gh-api-gh-token`. The result must report `APPROVAL REQUIRED`, backend `nono-hitl`, and a 60-second timeout.

## 2. Start the approval service

In host Terminal A:

```sh
cd /path/to/nono-hitl
just run serve --open
```

Confirm the trusted host and browser can connect:

```sh
curl --fail --show-error http://127.0.0.1:8765/healthz
```

Leave the service running. Do not start it from the untrusted profile being tested.

## 3. Run a composed one-shot test

### With the custom `gh-api`/`gh-auth-cli` profile

In host Terminal B:

```sh
nono run \
  --profile personal \
  --extends gh-approval-profile \
  --extends gh-api \
  --trust-proxy-ca \
  -- gh repo list --visibility private
```

### With the included official-CLI capture profile

```sh
nono run \
  --profile personal \
  --extends gh-approval-profile \
  --extends gh-api-gh-token \
  --trust-proxy-ca \
  -- gh repo list --visibility private
```

The command must pause before delegated `gh` launches. Review the request in the dashboard and select **Approve once**. The command should then list repositories visible to the selected credential, limited by its GitHub-side permissions.

Run the selected command again and choose **Deny**. It must produce a command-policy denial without listing repositories. Run it a third time without deciding; it must fail closed after approximately 55 seconds, before nono's 60-second webhook timeout.

## 4. Run through an agent session

Start a fresh agent with the same composition and no localhost grants. This example uses the custom `gh-api`; substitute `gh-api-gh-token` to use official-CLI capture:

```sh
nono run \
  --profile personal \
  --extends gh-approval-profile \
  --extends gh-api \
  --trust-proxy-ca \
  -- pi
```

Inside that session, test harmless and read-only operations:

```sh
gh --version
gh auth status
gh repo list --visibility private
gh api user --jq .login
```

Approve each invocation separately. The delegated `gh` may read `$XDG_CONFIG_HOME/gh`, but its API credential should come from the composed proxy route. Stop instead of adding broad Keychain access if the delegated child reports a Keychain denial.

## 5. Run the localhost security gate

With `nono-hitl` running, this request from inside the untrusted agent session must fail with `EPERM`, `Operation not permitted`, or another sandbox denial:

```sh
curl --noproxy '*' --connect-timeout 2 \
  http://127.0.0.1:8765/healthz
```

Also verify the resolved profile has no `open_port` or `listen_port` entry for `8765`. A delegated-child connectivity probe is still required before production use: run a fixed, trusted probe executable under the exact `gh` child sandbox and prove its TCP connection to `127.0.0.1:8765` is denied. Do not weaken the production profile with a writable fake executable or localhost grant for this test.

The no-auth MVP must not be used if either the agent or delegated child can connect to the approval API, or if the agent can bind port `8765` and impersonate it.

## 6. Test shutdown and audit output

Start an approval, leave it pending, and stop `nono-hitl` with Ctrl-C. The waiting invocation must be denied without launching `gh`.

After ending the nono session:

```sh
nono audit list --today
nono audit show <session-id> --json |
  rg 'invocation_approve_(granted|denied)|nono-hitl'
```

Confirm that approvals and denials identify the `nono-hitl` webhook backend and that deny, timeout, and shutdown never launch the command.
