import "./History.css";
import {
  fullTime,
  kindLabel,
  requestID,
  requestOf,
  requestSummary,
  requestTitle,
  safeInline,
  sessionLabel,
  shortTime,
  stateLabel,
} from "../format";
import { closeHistory, historyEntries, openHistory, setRowIndex, state } from "../store";
import type { Approval } from "../types";

// Resolved requests, newest first. A row opens its request on the card.
export function History() {
  return (
    <div class="list" id="history-items">
      {historyEntries().map((approval, index) => (
        <HistoryRow key={requestID(approval)} approval={approval} index={index} />
      ))}
    </div>
  );
}

function HistoryRow({ approval, index }: { approval: Approval; index: number }) {
  const request = requestOf(approval);
  const id = requestID(approval);
  const resolved = approval.resolution?.resolved_at;
  const how = safeInline(approval.resolution?.reason, 80);
  const label = sessionLabel(request.session_id, approval.session);
  return (
    <button
      class="list-row history-row"
      type="button"
      data-request-id={id}
      aria-current={index === state.rowIndex ? "true" : undefined}
      aria-label={`${stateLabel(approval.state)}: ${requestTitle(approval)}, ${fullTime(resolved)}`}
      onFocusIn={() => setRowIndex(index)}
      onClick={() => openHistory(id)}
    >
      <span class={`mini-stamp text-small ${approval.state}`}>{stateLabel(approval.state)}</span>
      <code class="break-anywhere">
        <span class="kind-badge text-small">{kindLabel(request)}</span>{" "}
        {safeInline(requestSummary(request), 200)}
      </code>
      <time
        class="text-small text-muted"
        dateTime={String(resolved ?? "")}
        title={fullTime(resolved)}
      >
        {shortTime(resolved)}
      </time>
      <span class="history-meta text-small text-muted">{how ? `${label}, ${how}` : label}</span>
    </button>
  );
}

export function BackButton() {
  return (
    <button class="quiet back" id="back" type="button" onClick={closeHistory}>
      <kbd class="hint">Esc</kbd> Back to history
    </button>
  );
}
