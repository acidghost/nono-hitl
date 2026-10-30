// Approvals, grants and the dashboard's UI state live in one object. Changes go through the
// functions below, and each one ends in emit(), which re-renders.
import {
  commandRequest,
  commandTitle,
  displayArgs,
  grantID,
  requestID,
  safeInline,
  sessionLabel,
  sessionWhere,
  stateLabel,
  timestamp,
} from "./format";
import { notify } from "./notifications";
import type { Approval, ApprovalState, Resolution, SessionGrant, Snapshot } from "./types";

// Approve keys and buttons wait this long after the shown request changes or the window
// gains focus, and approve keys need this much quiet before and after the keypress.
export const armMilliseconds = 1000;
export const quietMilliseconds = 300;

export const views = ["pending", "sessions", "history"] as const;
export type View = (typeof views)[number];
export type Connection = "connecting" | "online" | "offline";
export type Scope = "once" | "session";

export type SessionGroup = {
  sessionID: string;
  label: string;
  where: string;
  started: string | undefined;
  grants: SessionGrant[];
  shown: SessionGrant[];
};

// Sessions and History are flat row lists for j, k, x and Enter, whatever their grouping.
export type Row = { id: string; grant?: SessionGrant; approval?: Approval };

const shortcutsKey = "nono-hitl-shortcuts";

export const state = {
  pending: new Map<string, Approval>(),
  recent: new Map<string, Approval>(),
  grants: [] as SessionGrant[],
  connection: "connecting" as Connection,
  connectionLabel: "Connecting",
  sending: new Set<string>(),
  feedback: new Map<string, string>(),
  view: "pending" as View,
  selectedID: "",
  // History entry shown on the card; empty while the history list is shown.
  openedID: "",
  rowIndex: 0,
  filter: "",
  // Bumped when the current row, or the card, should take focus.
  rowFocus: 0,
  cardFocus: 0,
  // True while the approve buttons fill; armCount restarts the fill.
  arming: false,
  armCount: 0,
  // An approve key waiting out the quiet window.
  queued: undefined as { id: string; scope: Scope } | undefined,
  toast: { message: "", outcome: "", shown: false },
  live: "",
  helpOpen: false,
  detailsOpen: false,
  // The deny note form stands in for the action row.
  noteOpen: false,
  shortcutsOn: true,
  now: Date.now(),
};

const listeners = new Set<() => void>();
let shownID = "";
let stateVersion = 0;
let snapshotInFlight = false;
let eventSource: EventSource | undefined;
let armedAt = 0;
let armTimer: ReturnType<typeof setTimeout> | undefined;
let queueTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Every change ends here: settle the selection, arm a newly shown request, then render.
function emit() {
  state.now = Date.now();
  const pending = sortedPending();
  if (!state.pending.has(state.selectedID)) state.selectedID = requestID(pending[0]);
  if (!state.recent.has(state.openedID)) state.openedID = "";
  if (state.view !== "pending" && !state.openedID) {
    state.rowIndex = Math.max(0, Math.min(state.rowIndex, rows().length - 1));
  }
  const shown = shownApproval();
  const id = requestID(shown);
  if (id !== shownID) {
    shownID = id;
    state.detailsOpen = false;
    state.noteOpen = false;
    if (shown?.state === "pending") startArming();
  }
  for (const listener of listeners) listener();
}

export function start() {
  try {
    state.shortcutsOn = localStorage.getItem(shortcutsKey) !== "off";
  } catch {}
  document.documentElement.dataset.shortcuts = state.shortcutsOn ? "on" : "off";
  state.view = viewFromHash() || "pending";
  setConnection("connecting", "Connecting");
  void refreshSnapshot().finally(connectEvents);
  setInterval(() => void refreshSnapshot(), 15000);
}

// Re-renders without a state change, for the clock and browser permissions.
export function refresh() {
  emit();
}

export function sortedPending(): Approval[] {
  return [...state.pending.values()].sort(
    (left, right) => timestamp(left.created_at) - timestamp(right.created_at),
  );
}

export function shownApproval(): Approval | undefined {
  if (state.view === "pending") return state.pending.get(state.selectedID);
  if (state.view === "history") return state.recent.get(state.openedID);
  return undefined;
}

export function canDecide(approval: Approval | undefined): boolean {
  return (
    state.connection === "online" &&
    approval?.state === "pending" &&
    !state.sending.has(requestID(approval)) &&
    timestamp(approval.deadline) > Date.now()
  );
}

function setConnection(connection: Connection, label: string) {
  state.connection = connection;
  state.connectionLabel = label;
  emit();
}

function applySnapshot(snapshot: Partial<Snapshot>) {
  state.pending.clear();
  state.recent.clear();
  for (const approval of Array.isArray(snapshot?.pending) ? snapshot.pending : []) {
    const id = requestID(approval);
    if (id) state.pending.set(id, approval);
  }
  for (const approval of Array.isArray(snapshot?.recent) ? snapshot.recent : []) {
    const id = requestID(approval);
    if (id) {
      state.pending.delete(id);
      state.recent.set(id, approval);
    }
  }
  for (const id of state.feedback.keys()) {
    if (!state.pending.has(id)) state.feedback.delete(id);
  }
  state.grants = Array.isArray(snapshot?.grants) ? snapshot.grants : [];
  emit();
  notifyAll();
}

function applyPending(approval: Approval) {
  const id = requestID(approval);
  if (!id) return;
  const isNew = !state.pending.has(id);
  state.recent.delete(id);
  state.pending.set(id, approval);
  emit();
  if (isNew) {
    notifyPending(approval);
    // Off the Pending view only the badge would change, so say it out loud.
    if (state.view === "pending") announce(`Approval requested for ${commandTitle(approval)}`);
    else notice(`Approval requested for ${commandTitle(approval)}`);
  }
}

// A resolved request leaves the card; the next pending one takes its place and re-arms.
function applyResolved(approval: Approval) {
  const id = requestID(approval);
  if (!id) return;
  const shown = id === state.selectedID && state.pending.has(id);
  const actions = document.getElementById("pending-actions");
  if (shown && actions?.contains(document.activeElement)) state.cardFocus++;
  if (shown) state.selectedID = neighbourOf(id);
  state.pending.delete(id);
  state.recent.set(id, approval);
  state.feedback.delete(id);
  emit();
  notice(`${stateLabel(approval.state)}: ${commandTitle(approval)}`, approval.state);
}

function neighbourOf(id: string): string {
  const pending = sortedPending();
  const index = pending.findIndex((approval) => requestID(approval) === id);
  return requestID(pending[index + 1] ?? pending[index - 1]);
}

// Advice changes what the card says and can move its buttons, so the shown request re-arms.
function applyAdvice(approval: Approval) {
  const id = requestID(approval);
  const list = approval.state === "pending" ? state.pending : state.recent;
  if (!list.has(id)) return;
  list.set(id, approval);
  if (approval.state === "pending" && requestID(shownApproval()) === id) startArming();
  emit();
}

function applyGrants(list: SessionGrant[]) {
  state.grants = Array.isArray(list) ? list : [];
  emit();
}

async function refreshSnapshot() {
  if (snapshotInFlight) return;
  snapshotInFlight = true;
  const version = stateVersion;
  try {
    const response = await fetch("/api/v1/approvals", {
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`snapshot returned HTTP ${response.status}`);
    const snapshot = await response.json();
    // An event received during this fetch is newer than the HTTP snapshot.
    if (version !== stateVersion) return;
    applySnapshot(snapshot);
    if (eventSource?.readyState === EventSource.OPEN) {
      setConnection("online", "Connected locally");
    }
  } catch (error) {
    if (version === stateVersion) setConnection("offline", "Disconnected");
    console.warn("Could not refresh approval snapshot", error);
  } finally {
    snapshotInFlight = false;
  }
}

export function resync() {
  void refreshSnapshot();
}

function connectEvents() {
  if (eventSource) eventSource.close();
  setConnection("connecting", "Connecting");
  const events = new EventSource("/api/v1/events");
  eventSource = events;
  events.addEventListener("open", () => {
    // A transport connection alone does not reconcile missed resolutions.
    stateVersion++;
    setConnection("connecting", "Reconciling");
  });
  events.addEventListener("snapshot", (event) => {
    if (parseEvent(event, applySnapshot)) setConnection("online", "Connected locally");
  });
  events.addEventListener("pending", (event) => parseEvent(event, applyPending));
  events.addEventListener("resolved", (event) => parseEvent(event, applyResolved));
  events.addEventListener("grants", (event) => parseEvent(event, applyGrants));
  events.addEventListener("advice", (event) => parseEvent(event, applyAdvice));
  events.addEventListener("error", () => {
    stateVersion++;
    setConnection("offline", "Reconnecting");
  });
}

function parseEvent<T>(event: MessageEvent, apply: (payload: T) => void): boolean {
  stateVersion++;
  try {
    apply(JSON.parse(event.data));
    return true;
  } catch (error) {
    setConnection("connecting", "Reconciling");
    console.warn("Ignored malformed approval event", error);
    void refreshSnapshot();
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The caller pins the request ID when the user acts; it is never read back from the selection.
// nono shows the agent the reason of a denial, so a note there reaches the agent.
export async function decide(
  id: string,
  decision: "granted" | "denied",
  scope: Scope = "once",
  note = "",
) {
  const approval = state.pending.get(id);
  if (!approval || !canDecide(approval)) return;
  state.sending.add(id);
  state.feedback.set(id, decision === "granted" ? "Approving…" : "Denying…");
  const reasons = {
    once: decision === "granted" ? "Approved once in browser" : "Denied in browser",
    session: "Approved for session in browser",
  };
  const reason = note ? `${reasons[scope]}: ${note}` : reasons[scope];
  emit();
  try {
    const response = await fetch(`/api/v1/approvals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      credentials: "omit",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ decision, scope, reason }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `decision returned HTTP ${response.status}`);
    if (payload.state !== decision || !Number.isFinite(timestamp(payload.resolved_at))) {
      throw new Error("invalid decision response");
    }
    stateVersion++;
    const resolution = payload as Resolution;
    if (state.pending.has(id)) {
      applyResolved({ ...approval, state: resolution.state, resolution });
    }
  } catch (error) {
    stateVersion++;
    state.feedback.set(id, `Could not confirm decision: ${safeInline(errorMessage(error), 160)}`);
    setConnection("connecting", "Reconciling");
    announce("The decision could not be confirmed. Reconciling the request state.");
    void refreshSnapshot();
  } finally {
    state.sending.delete(id);
    emit();
  }
}

// One DELETE per grant; a session holds at most as many grants as the store keeps.
export async function revoke(ids: string[]) {
  if (ids.length === 0 || ids.some((id) => !id)) return;
  if (state.connection !== "online") {
    notice("Disconnected. Revoke again once the dashboard reconnects.");
    return;
  }
  try {
    for (const id of ids) {
      const response = await fetch(`/api/v1/grants/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`revoke returned HTTP ${response.status}`);
      }
    }
    notice(
      ids.length === 1 ? "Session approval revoked." : `${ids.length} session approvals revoked.`,
    );
  } catch (error) {
    notice(`Could not revoke session approval: ${safeInline(errorMessage(error), 160)}`);
  } finally {
    void refreshSnapshot();
  }
}

function startArming() {
  dropQueued();
  armedAt = performance.now() + armMilliseconds;
  state.arming = true;
  state.armCount++;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    state.arming = false;
    emit();
  }, armMilliseconds);
}

// The window gaining focus re-arms, so a click that brings it forward can't approve.
export function arm() {
  startArming();
  emit();
}

export function isArmed(): boolean {
  return performance.now() >= armedAt;
}

export function approveByClick(id: string, scope: Scope) {
  if (!isArmed()) {
    notice("Not armed yet. Wait for the bar to fill.");
    return;
  }
  void decide(id, "granted", scope);
}

// Approves after the quiet window unless another key cancels it first.
export function queueApproval(id: string, scope: Scope) {
  dropQueued();
  state.queued = { id, scope };
  queueTimer = setTimeout(() => {
    state.queued = undefined;
    emit();
    void decide(id, "granted", scope);
  }, quietMilliseconds);
  emit();
}

function dropQueued() {
  clearTimeout(queueTimer);
  state.queued = undefined;
}

export function cancelQueued() {
  dropQueued();
  emit();
}

export function selectRequest(id: string) {
  state.selectedID = id;
  emit();
}

export function moveSelection(step: number): boolean {
  const pending = sortedPending();
  if (pending.length === 0) return false;
  const index = pending.findIndex((approval) => requestID(approval) === state.selectedID);
  const next = index < 0 ? 0 : Math.max(0, Math.min(pending.length - 1, index + step));
  selectRequest(requestID(pending[next]));
  return true;
}

export function selectIndex(index: number) {
  const target = sortedPending()[index];
  if (target) selectRequest(requestID(target));
}

export function viewFromHash(): View | "" {
  const name = window.location.hash.slice(1);
  return views.find((view) => view === name) ?? "";
}

export function setView(name: View) {
  if (name === state.view) return;
  state.view = name;
  state.openedID = "";
  state.rowIndex = 0;
  state.filter = "";
  emit();
}

// The hash keeps the view across reloads; hashchange catches links and the back button.
export function showView(name: View) {
  if (window.location.hash !== `#${name}`) window.location.hash = name;
  setView(name);
}

export function openHistory(id: string) {
  state.openedID = id;
  state.cardFocus++;
  emit();
}

export function closeHistory() {
  state.openedID = "";
  state.rowFocus++;
  emit();
}

export function setFilter(text: string) {
  state.filter = text;
  state.rowIndex = 0;
  emit();
}

export function moveRow(step: number): boolean {
  const count = rows().length;
  if (count === 0) return false;
  state.rowIndex = Math.max(0, Math.min(count - 1, state.rowIndex + step));
  state.rowFocus++;
  emit();
  return true;
}

// A row that gains focus, by Tab or click, becomes the current row.
export function setRowIndex(index: number) {
  if (index === state.rowIndex) return;
  state.rowIndex = index;
  emit();
}

function matchesFilter(...values: unknown[]): boolean {
  const query = state.filter.trim().toLowerCase();
  return (
    !query ||
    values.some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(query),
    )
  );
}

export function sessionGroups(): SessionGroup[] {
  const bySession = new Map<string, SessionGrant[]>();
  for (const grant of state.grants) {
    const id = String(grant.session_id ?? "");
    const list = bySession.get(id) ?? [];
    list.push(grant);
    bySession.set(id, list);
  }
  const groups: SessionGroup[] = [];
  for (const [sessionID, grants] of bySession) {
    const record = grants.find((grant) => grant.session)?.session;
    const label = sessionLabel(sessionID, record);
    const where = sessionWhere(record);
    const shown = grants.filter((grant) => matchesFilter(label, where, displayArgs(grant.args)));
    if (shown.length > 0) {
      groups.push({ sessionID, label, where, started: record?.started, grants, shown });
    }
  }
  return groups;
}

export function historyEntries(): Approval[] {
  return [...state.recent.values()]
    .sort(
      (left, right) =>
        timestamp(right.resolution?.resolved_at) - timestamp(left.resolution?.resolved_at),
    )
    .filter((approval) => {
      const request = commandRequest(approval);
      return matchesFilter(
        displayArgs(request.args),
        sessionLabel(request.session_id, approval.session),
        stateLabel(approval.state),
        approval.resolution?.reason,
      );
    });
}

export function rows(): Row[] {
  if (state.view === "sessions") {
    return sessionGroups().flatMap((group) =>
      group.shown.map((grant) => ({ id: grantID(grant), grant })),
    );
  }
  if (state.view === "history" && !state.openedID) {
    return historyEntries().map((approval) => ({ id: requestID(approval), approval }));
  }
  return [];
}

// Visible confirmation; the live region reads out the same text.
export function notice(message: string, outcome: ApprovalState | "" = "") {
  state.toast = { message, outcome, shown: true };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = { ...state.toast, shown: false };
    emit();
  }, 3000);
  announce(message);
}

// Clearing first makes screen readers repeat a message that hasn't changed.
export function announce(message: string) {
  state.live = "";
  emit();
  setTimeout(() => {
    state.live = message;
    emit();
  }, 0);
}

export function setHelpOpen(open: boolean) {
  if (open === state.helpOpen) return;
  state.helpOpen = open;
  emit();
}

export function setDetailsOpen(open: boolean) {
  if (open === state.detailsOpen) return;
  state.detailsOpen = open;
  emit();
}

// The note field takes focus, so what's typed there reaches no shortcut.
export function openNote() {
  state.noteOpen = true;
  emit();
  document.getElementById("deny-note")?.focus();
}

export function closeNote() {
  state.noteOpen = false;
  emit();
}

export function setShortcuts(on: boolean) {
  state.shortcutsOn = on;
  try {
    localStorage.setItem(shortcutsKey, on ? "on" : "off");
  } catch {}
  document.documentElement.dataset.shortcuts = on ? "on" : "off";
  emit();
}

function notifyPending(approval: Approval) {
  const id = requestID(approval);
  notify(approval, () => {
    if (!state.pending.has(id)) return false;
    showView("pending");
    selectRequest(id);
    return true;
  });
}

export function notifyAll() {
  state.pending.forEach(notifyPending);
}
