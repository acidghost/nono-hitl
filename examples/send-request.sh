#!/bin/sh
# Sends a fake nono command approval request and prints the decision.
# Usage: send-request.sh gh pr create --fill
set -eu

if [ $# -eq 0 ]; then
    echo "usage: $0 command [args...]" >&2
    exit 1
fi

body=$(jq -n \
    --arg id "dev-$(date +%s)-$$" \
    --arg session "${SESSION_ID:-dev-session}" \
    '{
        backend: "nono-hitl",
        request: {
            capability_type: "command",
            request_id: $id,
            command: $ARGS.positional[0],
            args: $ARGS.positional,
            caller: "session",
            intercept_rule: "invocation_policy.default",
            child_pid: 1,
            session_id: $session
        }
    }' --args -- "$@")

curl --fail-with-body --silent --show-error \
    -H 'Content-Type: application/json' \
    --data "$body" \
    "${NONO_HITL_URL:-http://127.0.0.1:8765}/hooks/nono"
