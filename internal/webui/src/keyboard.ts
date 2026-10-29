// Global shortcuts. Approve keys are guarded so text typed for the terminal can't approve.
import { grantID } from "./format";
import {
  cancelQueued,
  canDecide,
  closeHistory,
  decide,
  isArmed,
  moveRow,
  moveSelection,
  notice,
  openHistory,
  openNote,
  queueApproval,
  quietMilliseconds,
  revoke,
  rows,
  type Scope,
  selectIndex,
  setDetailsOpen,
  setFilter,
  setHelpOpen,
  shownApproval,
  showView,
  state,
  type View,
} from "./store";

let lastKeyAt = Number.NEGATIVE_INFINITY;

export function onKeyDown(event: KeyboardEvent) {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  const now = performance.now();
  const gap = now - lastKeyAt;
  lastKeyAt = now;
  if (state.queued) {
    cancelQueued();
    notice("Typing detected. Shortcut ignored.");
    event.preventDefault();
    return;
  }
  if (!state.shortcutsOn || event.repeat) return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("input:not([type='checkbox']), select, textarea")
  ) {
    return;
  }
  // Letters match either case so Caps Lock can't change scope; only Shift does.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (handleKey(key, event.shiftKey, gap)) event.preventDefault();
}

const viewKeys: Record<string, View> = { p: "pending", s: "sessions", h: "history" };

function handleKey(key: string, shift: boolean, gap: number): boolean {
  if (key === "?") {
    setHelpOpen(!state.helpOpen);
    return true;
  }
  if (state.helpOpen) return false;
  const view = viewKeys[key];
  if (view) {
    showView(view);
    return true;
  }
  if (state.view !== "pending") return handleListKey(key, shift);
  if (key === "j" || key === "ArrowDown" || key === "ArrowRight") return moveSelection(1);
  if (key === "k" || key === "ArrowUp" || key === "ArrowLeft") return moveSelection(-1);
  if (/^[1-9]$/.test(key)) {
    selectIndex(Number(key) - 1);
    return true;
  }
  const shown = shownApproval();
  if (!shown) return false;
  if (key === "i") {
    setDetailsOpen(!state.detailsOpen);
    return true;
  }
  // With the note open, its own Deny and Cancel are the only decisions on screen.
  if (shown.state !== "pending" || state.noteOpen) return false;
  if (key === "n") {
    if (!shift) void decide(state.selectedID, "denied");
    else if (canDecide(shown)) openNote();
    return true;
  }
  if (key === "y") {
    approveByKey(shift ? "session" : "once", gap);
    return true;
  }
  return false;
}

function handleListKey(key: string, shift: boolean): boolean {
  if (state.openedID) {
    if (key === "Escape") {
      closeHistory();
      return true;
    }
    if (key === "i") {
      setDetailsOpen(!state.detailsOpen);
      return true;
    }
    return false;
  }
  if (key === "/") {
    document.getElementById("filter")?.focus();
    return true;
  }
  if (key === "Escape" && state.filter) {
    setFilter("");
    return true;
  }
  if (key === "j" || key === "ArrowDown") return moveRow(1);
  if (key === "k" || key === "ArrowUp") return moveRow(-1);
  const row = rows()[state.rowIndex];
  if (!row) return false;
  // A focused row opens itself through its own click.
  if (key === "Enter" && row.approval && document.activeElement === document.body) {
    openHistory(row.id);
    return true;
  }
  if (key === "x" && row.grant) {
    const sessionID = row.grant.session_id;
    const chosen = shift
      ? state.grants.filter((grant) => grant.session_id === sessionID)
      : [row.grant];
    void revoke(chosen.map(grantID));
    return true;
  }
  return false;
}

// Fires after a quiet window, so typing that lands in the browser can't approve.
function approveByKey(scope: Scope, gap: number) {
  const id = state.selectedID;
  if (!canDecide(state.pending.get(id))) return;
  if (gap < quietMilliseconds) {
    notice("Typing detected. Shortcut ignored.");
    return;
  }
  if (!isArmed()) {
    notice("Not armed yet. Wait for the bar to fill.");
    return;
  }
  queueApproval(id, scope);
}
