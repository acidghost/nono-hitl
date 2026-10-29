import "./Sessions.css";
import {
  displayArgs,
  fullTime,
  grantID,
  grantUsage,
  safeInline,
  shortTime,
  timestamp,
} from "../format";
import { revoke, type SessionGroup, sessionGroups, setRowIndex, state } from "../store";
import type { SessionGrant } from "../types";

// Session approvals grouped by session. Rows are keyed by grant ID, so the DOM under a group,
// and anything typed or focused there, survives every grants event.
export function Sessions() {
  let index = 0;
  return (
    <div id="session-groups">
      {sessionGroups().map((group) => (
        <section class="session-group" key={group.sessionID}>
          <div class="session-head row">
            <SessionTitle group={group} />
            <button
              class="quiet text-small"
              type="button"
              aria-label={`Revoke all session approvals for ${group.label}`}
              onClick={() => void revoke(group.grants.map(grantID))}
            >
              <kbd class="hint">⇧X</kbd> Revoke all {group.grants.length}
            </button>
          </div>
          {group.shown.map((grant) => (
            <GrantRow key={grantID(grant)} grant={grant} index={index++} />
          ))}
        </section>
      ))}
    </div>
  );
}

function SessionTitle({ group }: { group: SessionGroup }) {
  const started = Number.isFinite(timestamp(group.started));
  return (
    <div class="session-title">
      <h2 class="session-name break-anywhere">{group.label}</h2>
      {(group.where || started) && (
        <p class="text-small text-muted break-anywhere">
          {group.where}
          {started && (
            <>
              {group.where ? ", started " : "Started "}
              <time dateTime={String(group.started)} title={fullTime(group.started)}>
                {shortTime(group.started)}
              </time>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function GrantRow({ grant, index }: { grant: SessionGrant; index: number }) {
  const args = displayArgs(grant.args);
  return (
    <div
      class="list-row grant-row"
      tabIndex={-1}
      data-request-id={grantID(grant)}
      aria-current={index === state.rowIndex ? "true" : undefined}
      onFocusIn={() => setRowIndex(index)}
    >
      <code class="break-anywhere pre-wrap">{args}</code>
      <span class="text-small text-muted">
        approved {shortTime(grant.created_at)}, {grantUsage(grant)}
      </span>
      <button
        class="quiet text-small"
        type="button"
        aria-label={`Revoke session approval for ${safeInline(args, 100)}`}
        onClick={() => void revoke([grantID(grant)])}
      >
        <kbd class="hint">x</kbd> Revoke
      </button>
    </div>
  );
}
