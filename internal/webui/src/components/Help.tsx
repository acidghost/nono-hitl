import "./Help.css";
import { Fragment } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { announce, setHelpOpen, setShortcuts, state } from "../store";
import { setThemeMode, themeMode, validMode } from "../theme";

// Everything that teaches the tool once, plus the two preferences.
export function Help() {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (state.helpOpen && !element?.open) element?.showModal();
    if (!state.helpOpen && element?.open) element.close();
  });
  return (
    <dialog
      class="help"
      id="help"
      aria-labelledby="help-title"
      ref={dialog}
      onClose={() => setHelpOpen(false)}
    >
      <div class="help-head row spread">
        <h2 id="help-title">Help</h2>
        <button class="quiet" id="help-close" type="button" onClick={() => setHelpOpen(false)}>
          Close
        </button>
      </div>
      <ul class="help-notes">
        <li>Unanswered requests are denied at their deadline. Missing one never approves it.</li>
        <li>
          Approve once covers this invocation only. Approve for session also covers later requests
          from the same nono session with exactly the same command, argument array, caller and rule,
          until you revoke it or the session exits.
        </li>
        <li>
          Approving lets nono run the command in the child sandbox set by the profile. It adds no
          permissions.
        </li>
        <li>
          A deny note reaches the agent in nono's error for the blocked command, so it can say what
          to run instead.
        </li>
        <li>Decisions are kept in memory and cleared when the service restarts.</li>
        <li>
          Approve keys work one second after a request appears, and only after a pause in typing, so
          text meant for the terminal can't approve anything.
        </li>
        <li>
          Listening on <code id="listener">{window.location.host}</code>. Run this service outside
          the agent sandbox.
        </li>
      </ul>
      <h3 class="text-body">Keyboard</h3>
      <dl class="keys">
        <Keys keys={["j", "k"]}>Next or previous request or row</Keys>
        <div>
          <dt>
            <kbd>1</kbd> to <kbd>9</kbd>
          </dt>
          <dd>Jump to a request</dd>
        </div>
        <Keys keys={["y"]}>Approve once</Keys>
        <Keys keys={["⇧Y"]}>Approve for session</Keys>
        <Keys keys={["n"]}>Deny</Keys>
        <Keys keys={["⇧N"]}>Deny with a note for the agent</Keys>
        <Keys keys={["i"]}>Details</Keys>
        <Keys keys={["p", "s", "h", "c"]}>Pending, Sessions, History, Config</Keys>
        <Keys keys={["/"]}>Filter sessions or history</Keys>
        <Keys keys={["x"]}>Revoke a session approval</Keys>
        <Keys keys={["⇧X"]}>Revoke a whole session</Keys>
        <Keys keys={["Enter"]}>Open a history entry</Keys>
        <Keys keys={["?"]}>This help</Keys>
        <Keys keys={["Esc"]}>Close, clear the filter, go back</Keys>
      </dl>
      <div class="help-settings row">
        <label class="row gap-small" for="shortcuts">
          <input
            type="checkbox"
            id="shortcuts"
            checked={state.shortcutsOn}
            onChange={(event) => setShortcuts(event.currentTarget.checked)}
          />
          Keyboard shortcuts
        </label>
        <label class="theme-picker row gap-small" for="color-theme">
          Theme
          <select id="color-theme" value={themeMode()} onChange={pickTheme}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
    </dialog>
  );
}

function Keys({ keys, children }: { keys: string[]; children: string }) {
  return (
    <div>
      <dt>
        {keys.map((key, index) => (
          <Fragment key={key}>
            {index > 0 && " "}
            <kbd>{key}</kbd>
          </Fragment>
        ))}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function pickTheme(event: Event) {
  const mode = (event.currentTarget as HTMLSelectElement).value;
  if (!validMode(mode)) return;
  setThemeMode(mode);
  announce(`Theme set to ${mode}.`);
}
