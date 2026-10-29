import "./Decision.css";
import { requestID, stateLabel } from "../format";
import {
  approveByClick,
  armMilliseconds,
  canDecide,
  closeNote,
  decide,
  openNote,
  type Scope,
  state,
} from "../store";
import type { Approval } from "../types";

// Decision buttons while the request waits, the outcome's stamp once it is resolved. Every
// handler acts on the request this card shows, never on whatever is selected by then.
export function Decision({ approval, sessionLabel }: { approval: Approval; sessionLabel: string }) {
  return (
    <div class="decision-area">
      {approval.state === "pending" ? (
        <Actions approval={approval} sessionLabel={sessionLabel} />
      ) : (
        <Outcome approval={approval} />
      )}
    </div>
  );
}

function Actions({ approval, sessionLabel }: { approval: Approval; sessionLabel: string }) {
  const id = requestID(approval);
  const disabled = !canDecide(approval);
  const shortcut = (key: string) => (state.shortcutsOn ? key : undefined);
  const pressing = (scope: Scope) => state.queued?.id === id && state.queued.scope === scope;
  // A new key on each arm remounts the bar, which restarts its animation; the buttons around
  // it stay, and keep focus.
  const fill = () => <span class="arm-fill" key={state.armCount} aria-hidden="true" />;
  return (
    <div id="pending-actions">
      <p id="decision-feedback" class="decision-feedback break-anywhere pre-wrap" role="status">
        {state.feedback.get(id)}
      </p>
      {state.noteOpen ? (
        <NoteForm id={id} disabled={disabled} />
      ) : (
        <div class="action-row row">
          <span class="scope text-small text-muted" id="scope">
            Session approval covers this exact argv in {sessionLabel}
          </span>
          <div
            class={state.arming ? "actions row gap-small arming" : "actions row gap-small"}
            style={{ "--arm-ms": `${armMilliseconds}ms` }}
          >
            <button
              class="button-deny"
              id="deny-with-note"
              type="button"
              disabled={disabled}
              aria-keyshortcuts={shortcut("Shift+N")}
              onClick={openNote}
            >
              <kbd class="hint">⇧N</kbd>Deny with note
            </button>
            <button
              class="deny button-deny"
              id="deny"
              type="button"
              disabled={disabled}
              aria-keyshortcuts={shortcut("n")}
              onClick={() => void decide(id, "denied")}
            >
              <kbd class="hint">n</kbd>Deny
            </button>
            <button
              class={pressing("session") ? "armed pressing" : "armed"}
              id="approve-session"
              type="button"
              disabled={disabled}
              aria-keyshortcuts={shortcut("Shift+Y")}
              onClick={() => approveByClick(id, "session")}
            >
              {fill()}
              <kbd class="hint">⇧Y</kbd>Approve for session
            </button>
            <button
              class={
                pressing("once")
                  ? "approve armed row gap-small pressing"
                  : "approve armed row gap-small"
              }
              id="approve"
              type="button"
              disabled={disabled}
              aria-keyshortcuts={shortcut("y")}
              onClick={() => approveByClick(id, "once")}
            >
              {fill()}
              <kbd class="hint">y</kbd>
              <span>Approve once</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Fits the server's 4 KiB reason cap in any encoding, and nono's cap on the message it prints.
const noteMaxLength = 1000;

// Stands in for the action row while the user writes. Escape and Cancel return to it.
function NoteForm({ id, disabled }: { id: string; disabled: boolean }) {
  return (
    <form
      class="action-row note-form row"
      onSubmit={(event) => {
        event.preventDefault();
        const note = new FormData(event.currentTarget).get("note");
        void decide(id, "denied", "once", String(note ?? "").trim());
      }}
    >
      <label class="text-small text-muted" for="deny-note">
        Note for the agent
      </label>
      <input
        id="deny-note"
        name="note"
        type="text"
        maxLength={noteMaxLength}
        autocomplete="off"
        placeholder="What to run instead, or why not"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          closeNote();
        }}
      />
      <div class="actions row gap-small">
        <button class="deny button-deny" id="deny-note-send" type="submit" disabled={disabled}>
          Deny
        </button>
        <button id="deny-note-cancel" type="button" onClick={closeNote}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Outcome({ approval }: { approval: Approval }) {
  const title =
    approval.state !== "granted"
      ? "This request did not receive approval."
      : approval.resolution?.scope === "session"
        ? "Approval granted for this nono session."
        : "Approval granted for this invocation.";
  return (
    <div id="terminal" class="terminal row spread">
      <div>
        <h3 class="text-body" id="terminal-title">
          {title}
        </h3>
        <p class="text-small text-muted break-anywhere pre-wrap" id="terminal-reason">
          {approval.resolution?.reason ?? ""}
        </p>
      </div>
      <div class={`stamp ${approval.state}`} id="stamp">
        {stateLabel(approval.state)}
      </div>
    </div>
  );
}
