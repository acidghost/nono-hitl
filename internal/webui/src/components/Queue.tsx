import "./Queue.css";
import {
  commandRequest,
  commandTitle,
  countdown,
  duration,
  requestID,
  sessionLabel,
} from "../format";
import { selectRequest, sortedPending, state } from "../store";
import type { Approval } from "../types";

// Filing tabs on top of the card, one per waiting request, oldest first.
export function Queue() {
  return (
    <nav id="queue-items" class="queue-items" aria-label="Waiting requests">
      {sortedPending().map((approval, index) => (
        <QueueTab key={requestID(approval)} approval={approval} index={index} />
      ))}
    </nav>
  );
}

function QueueTab({ approval, index }: { approval: Approval; index: number }) {
  const id = requestID(approval);
  const { remaining, left, urgent } = countdown(approval.created_at, approval.deadline, state.now);
  return (
    <button
      type="button"
      class={urgent ? "queue-item urgent" : "queue-item"}
      data-request-id={id}
      aria-pressed={id === state.selectedID ? "true" : "false"}
      aria-controls="sheet"
      style={{ "--left": String(left) }}
      onClick={() => selectRequest(id)}
    >
      <span class="deadline-bar" />
      <span class="queue-command">
        {index < 9 && (
          <>
            <kbd class="hint">{index + 1}</kbd>{" "}
          </>
        )}
        {commandTitle(approval)}
      </span>
      <span class="clock text-small">{duration(remaining)}</span>
      <span class="queue-meta text-small text-muted">
        {sessionLabel(commandRequest(approval).session_id, approval.session)}
      </span>
    </button>
  );
}
