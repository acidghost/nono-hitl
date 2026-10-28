#!/bin/sh
# Sends a fake nono command approval request and prints the decision.
# Usage: send-request.sh gh pr create --fill
# SESSION_ID, CALLER, RULE and REASON override the reported request fields.
set -eu

if [ $# -eq 0 ]; then
    echo "usage: $0 command [args...]" >&2
    exit 1
fi

body=$(jq -n \
    --arg id "dev-$(date +%s)-$$" \
    --arg session "${SESSION_ID:-dev-session}" \
    --arg caller "${CALLER:-session}" \
    --arg rule "${RULE:-invocation_policy.default}" \
    --arg reason "${REASON:-}" \
    '{
        backend: "nono-hitl",
        request: {
            capability_type: "command",
            request_id: $id,
            command: $ARGS.positional[0],
            args: $ARGS.positional,
            caller: $caller,
            intercept_rule: $rule,
            reason: (if $reason == "" then null else $reason end),
            child_pid: 1,
            session_id: $session
        }
    }' --args -- "$@")

curl --fail-with-body --silent --show-error \
    -H 'Content-Type: application/json' \
    --data "$body" \
    "${NONO_HITL_URL:-http://127.0.0.1:8765}/hooks/nono"
