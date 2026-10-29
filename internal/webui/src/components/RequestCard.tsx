import "./RequestCard.css";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import {
  clip,
  commandRequest,
  commandTitle,
  countdown,
  displayArg,
  displayArgs,
  duration,
  requestID,
  rulePath,
  safeInline,
  sessionLabel,
  sessionWhere,
  shortTime,
  stateLabel,
} from "../format";
import { setDetailsOpen, state } from "../store";
import type { Approval, CommandRequest, SessionRecord } from "../types";
import { Decision } from "./Decision";

// The card for one request: session line, argv, exceptions, decision, then details. App keys
// it by request ID, so nothing a user expanded carries over to the next request.
export function RequestCard({ approval }: { approval: Approval }) {
  const request = commandRequest(approval);
  const args = Array.isArray(request.args) ? request.args : [];
  const id = requestID(approval);
  const waiting = approval.state === "pending";
  const { remaining, left, urgent } = countdown(approval.created_at, approval.deadline, state.now);
  const label = sessionLabel(request.session_id, approval.session);
  return (
    <section
      class={waiting && urgent ? "sheet urgent" : "sheet"}
      id="sheet"
      aria-labelledby="request-title"
      aria-busy={state.sending.has(id) ? "true" : "false"}
      data-state={approval.state}
      style={waiting ? { "--left": String(left) } : undefined}
    >
      <div class="deadline-bar" aria-hidden="true" />
      <div class="sheet-body" id="review" tabIndex={-1}>
        <h2 class="sr-only" id="request-title">
          {commandTitle(approval)}
        </h2>
        <p class="who row text-muted">
          <span>Session</span>
          <strong id="session">{label}</strong>
          {approval.session && (
            <span class="break-anywhere" id="session-where">
              {sessionWhere(approval.session)}
            </span>
          )}
          <span class="clock" id="clock">
            {waiting
              ? duration(remaining)
              : `${stateLabel(approval.state)} ${shortTime(approval.resolution?.resolved_at)}`}
          </span>
        </p>
        <div class="argv-chips" id="command">
          {args.map((arg, index) => (
            <Chip key={index} arg={arg} command={index === 0} />
          ))}
        </div>
        <Exception request={request} />
      </div>
      <Decision approval={approval} sessionLabel={label} />
      <details
        class="technical"
        id="details"
        open={state.detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary class="row gap-small">Details</summary>
        <dl class="tech-grid" id="technical-data">
          <Item label="Arguments">
            <table class="argv-table" aria-label="Argument array, JSON-escaped values">
              {args.map((arg, index) => (
                <tr key={index}>
                  <th class="text-muted" scope="row">
                    argv[{index}]
                  </th>
                  <td>
                    <code class="pre-wrap">{JSON.stringify(arg)}</code>
                  </td>
                </tr>
              ))}
            </table>
          </Item>
          <Field label="Command" value={JSON.stringify(request.command)} />
          <Field label="Caller" value={request.caller} />
          <Field label="Rule" value={rulePath(request)} />
          <Field label="Reason" value={request.reason || "—"} />
          <Field label="Session ID" value={request.session_id} />
          {approval.session && <SessionFields record={approval.session} />}
          <Field label="Request ID" value={id} />
          <Field label="Shim PID" value={request.child_pid} />
          <Field label="Backend" value={approval.envelope?.backend} />
          <Field label="Received" value={approval.created_at} />
          <Field label="Deadline" value={approval.deadline} />
        </dl>
        <p class="text-small text-muted">
          The request doesn't include the child's filesystem, network or credential grants. Those
          live in the nono profile.
        </p>
      </details>
    </section>
  );
}

// Long arguments are clipped, never hidden: the button says how much is left out.
function Chip({ arg, command }: { arg: string; command: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const text = displayArg(arg);
  const { head, hidden } = clip(text);
  return (
    <>
      <code class={command ? "chip chip-command" : "chip"}>
        {expanded || hidden === 0 ? text : head}
      </code>
      {hidden > 0 && (
        <button
          type="button"
          class="chip-toggle text-small"
          aria-expanded={expanded ? "true" : "false"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : `+${hidden} chars`}
        </button>
      )}
    </>
  );
}

// Only what differs from a plain agent request reaching the default rule.
function Exception({ request }: { request: Partial<CommandRequest> }) {
  const launched = request.caller !== "session";
  const matched = request.reason || request.intercept_rule !== "invocation_policy.default";
  if (!launched && !request.reason && !matched) return null;
  return (
    <div class="exception" id="exception">
      {launched && (
        <p class="break-anywhere">
          Launched by <code>{safeInline(request.caller, 100)}</code>, not directly by the agent.
        </p>
      )}
      {request.reason && (
        <p class="exception-reason break-anywhere">{safeInline(request.reason, 300)}</p>
      )}
      {matched && (
        <p class="text-small break-anywhere">
          Matched <code>{rulePath(request)}</code>
        </p>
      )}
    </div>
  );
}

function SessionFields({ record }: { record: SessionRecord }) {
  return (
    <>
      <Field label="Session command" value={displayArgs(record.command)} />
      <Field label="Profile" value={record.profile || "—"} />
      <Field label="Working directory" value={record.workdir} />
      <Field label="Session started" value={record.started} />
    </>
  );
}

function Item({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div>
      <dt class="text-small text-muted">{label}</dt>
      <dd class="break-anywhere">{children}</dd>
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <Item label={label}>
      <code class="text-small pre-wrap">{String(value ?? "—")}</code>
    </Item>
  );
}
