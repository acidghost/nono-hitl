import "./Topbar.css";
import { notificationsSupported } from "../notifications";
import { refresh, setHelpOpen, state, type View } from "../store";

export function Topbar() {
  return (
    <header class="topbar row">
      <p class="brand row gap-small">
        <img src="/assets/logo.svg" alt="" width={24} height={24} />
        <span>nono / hitl</span>
      </p>
      <nav class="views row gap-small" aria-label="Views">
        <ViewLink view="pending" label="Pending" hint="p" count={state.pending.size} />
        <ViewLink view="sessions" label="Sessions" hint="s" count={state.grants.length} />
        <ViewLink view="history" label="History" hint="h" />
      </nav>
      <div class="status row text-small text-muted">
        <p
          id="connection"
          class="connection row gap-small"
          data-state={state.connection}
          role="status"
        >
          <span class="dot" aria-hidden="true" />
          <span id="connection-label">{state.connectionLabel}</span>
        </p>
        <NotificationButton />
        <button
          class="help-button"
          id="help-open"
          type="button"
          aria-haspopup="dialog"
          aria-controls="help"
          title="Help"
          onClick={() => setHelpOpen(true)}
        >
          ?
        </button>
      </div>
    </header>
  );
}

type ViewLinkProps = { view: View; label: string; hint: string; count?: number };

function ViewLink({ view, label, hint, count }: ViewLinkProps) {
  return (
    <a
      class="view-link row gap-small"
      id={`view-${view}`}
      href={`#${view}`}
      aria-current={state.view === view ? "page" : undefined}
    >
      {label}{" "}
      {count !== undefined && (
        <span class="badge" id={view === "pending" ? "pending-count" : "grant-count"}>
          {count}
        </span>
      )}
      <kbd class="hint">{hint}</kbd>
    </a>
  );
}

// The button only shows while there is something to do or to know.
function NotificationButton() {
  if (!notificationsSupported() || Notification.permission === "granted") return null;
  const blocked = Notification.permission === "denied";
  return (
    <button class="quiet" id="notification" type="button" disabled={blocked} onClick={ask}>
      {blocked ? "Notifications blocked" : "Enable notifications"}
    </button>
  );
}

async function ask() {
  try {
    await Notification.requestPermission();
  } catch (error) {
    console.warn("Could not request notification permission", error);
  }
  refresh();
}
