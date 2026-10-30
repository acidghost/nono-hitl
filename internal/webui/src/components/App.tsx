import "./App.css";
import type { TargetedKeyboardEvent } from "preact";
import { requestID, safeInline } from "../format";
import { rows, setFilter, shownApproval, sortedPending, state } from "../store";
import { Config } from "./Config";
import { Help } from "./Help";
import { BackButton, History } from "./History";
import { Queue } from "./Queue";
import { RequestCard } from "./RequestCard";
import { Sessions } from "./Sessions";
import { Toast } from "./Toast";
import { Topbar } from "./Topbar";

export function App() {
  const shown = shownApproval();
  const lists = (state.view === "sessions" || state.view === "history") && !state.openedID;
  return (
    <>
      <a class="skip" href="#review">
        Skip to request
      </a>
      <div class="app">
        <Topbar />
        <main class="workspace" id="workspace">
          {state.connection !== "online" && (
            <p id="offline-banner" class="offline-banner" role="status">
              {state.connection === "offline" ? "Connection lost." : "Synchronizing request state."}{" "}
              Decisions are disabled until the request state is reconciled. Requests still deny at
              their deadlines.
            </p>
          )}
          {state.view === "pending" && <Queue />}
          {lists && <ListView />}
          {state.view === "config" && <Config />}
          {state.openedID && <BackButton />}
          {shown && <RequestCard key={requestID(shown)} approval={shown} />}
          {state.view === "pending" && sortedPending().length === 0 && <EmptySheet />}
        </main>
      </div>
      <Help />
      <Toast />
      <div id="live" class="sr-only" role="status" aria-live="polite">
        {state.live}
      </div>
    </>
  );
}

function ListView() {
  const sessions = state.view === "sessions";
  const empty = state.filter.trim()
    ? `Nothing matches "${safeInline(state.filter, 60)}".`
    : sessions
      ? "No session approvals."
      : "No decisions yet.";
  return (
    <>
      <label class="filter row gap-small" id="list-tools" for="filter">
        <kbd class="hint">/</kbd>
        <span class="sr-only">Filter</span>
        <input
          id="filter"
          type="search"
          placeholder="Filter by command or session"
          autocomplete="off"
          value={state.filter}
          onInput={(event) => setFilter(event.currentTarget.value)}
          onKeyDown={filterKeys}
        />
      </label>
      {sessions ? <Sessions /> : <History />}
      {rows().length === 0 && (
        <p class="list-empty text-muted" id="list-empty">
          {empty}
        </p>
      )}
    </>
  );
}

function filterKeys(event: TargetedKeyboardEvent<HTMLInputElement>) {
  if (event.key === "Escape") setFilter("");
  if (event.key === "Escape" || event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.blur();
  }
}

function EmptySheet() {
  return (
    <section class="sheet empty-sheet" id="empty-sheet">
      <h2>Nothing is waiting</h2>
      <p class="text-muted">
        New requests show up here and as a notification. Unanswered requests are denied at their
        deadline.
      </p>
    </section>
  );
}
