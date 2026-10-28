(() => {
  const preferenceKey = "nono-hitl-mint-theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const validMode = (value) => ["system", "light", "dark"].includes(value);
  const forced = new URLSearchParams(window.location.search).get("theme");
  let mode = "system";
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (validMode(saved)) mode = saved;
  } catch {} // file:// and private contexts may disallow storage.
  if (forced === "light" || forced === "dark") mode = forced;

  function applyTheme() {
    const effective = mode === "system" ? (system.matches ? "dark" : "light") : mode;
    document.documentElement.dataset.theme = effective;
    document.documentElement.dataset.themeMode = mode;
    const selector = document.getElementById("color-theme");
    if (selector) selector.value = mode;
  }
  applyTheme(); // Before the page's styles/body, avoiding the wrong-theme first paint.
  system.addEventListener("change", () => {
    if (mode === "system") applyTheme();
  });
  document.addEventListener("DOMContentLoaded", () => {
    const selector = document.getElementById("color-theme");
    selector.value = mode;
    selector.addEventListener("change", () => {
      if (!validMode(selector.value)) return;
      mode = selector.value;
      try {
        localStorage.setItem(preferenceKey, mode);
      } catch {}
      applyTheme();
      const status = document.getElementById("live");
      if (status) status.textContent = `Theme set to ${mode}.`;
    });
  });
})();

// The script runs in the head; dashboard elements are available after parsing.
document.addEventListener("DOMContentLoaded", () => {
  const clipLength = 120;
  // Approve keys and buttons wait this long after the shown request changes or the window
  // gains focus, and approve keys need this much quiet before and after the keypress.
  const armMilliseconds = 1000;
  const quietMilliseconds = 300;
  const shortcutsKey = "nono-hitl-shortcuts";
  const views = ["pending", "sessions", "history"];
  const $ = (id) => document.getElementById(id);
  const elements = { notifications: $("notification"), actionStatus: $("live") };
  const approvals = { pending: new Map(), recent: new Map() };
  let grants = [];
  const sending = new Set();
  const feedback = new Map();
  const notifiedIDs = new Set();
  const notificationOrder = [];
  let selectedID = "";
  let view = "pending";
  // History entry shown on the card; empty while the history list is shown.
  let openedID = "";
  let rows = [];
  let rowIndex = 0;
  let filterText = "";
  let renderedID = "";
  let connected = false;
  let eventSource;
  let stateVersion = 0;
  let snapshotInFlight = false;
  let armedAt = 0;
  let armTimer;
  let lastKeyAt = Number.NEGATIVE_INFINITY;
  let queued;
  let toastTimer;
  let shortcutsOn = true;
  try {
    shortcutsOn = localStorage.getItem(shortcutsKey) !== "off";
  } catch {}

  function requestID(approval) {
    return String(approval?.envelope?.request?.request_id ?? "");
  }

  function commandRequest(approval) {
    return approval?.envelope?.request ?? {};
  }

  function commandTitle(approval) {
    const request = commandRequest(approval);
    const args = Array.isArray(request.args) ? request.args : [];
    return safeInline([request.command, ...args.slice(1, 3)].join(" "), 100) || "Command request";
  }

  // record is nono's session record, when the service could read it.
  function sessionLabel(sessionID, record) {
    return safeInline(record?.name, 40) || safeInline(sessionID, 40) || "unknown session";
  }

  function sessionWhere(record) {
    const program = Array.isArray(record?.command) ? String(record.command[0] ?? "") : "";
    const agent = safeInline(program.split("/").pop(), 40);
    const workdir = safeInline(record?.workdir, 200);
    return agent && workdir ? `${agent} in ${workdir}` : agent || workdir;
  }

  // nono reports invocation policy labels relative to the caller's profile entry.
  function rulePath(request) {
    const rule = String(request.intercept_rule ?? "");
    if (!rule.startsWith("invocation_policy.")) return rule;
    return `commands.${request.command}.from.${request.caller}.${rule}`;
  }

  // Display only: these tokens are reported argv, never executable shell text.
  function displayArg(arg) {
    return /^[a-zA-Z0-9_./:@#=+-]+$/.test(arg) ? arg : JSON.stringify(arg);
  }

  function displayArgs(args) {
    return (Array.isArray(args) ? args : []).map(displayArg).join(" ");
  }

  function setConnection(state, label) {
    connected = state === "online";
    $("connection").dataset.state = state;
    $("connection-label").textContent = label;
    $("offline-banner").hidden = connected;
    $("offline-banner").textContent =
      `${state === "offline" ? "Connection lost." : "Synchronizing request state."} Decisions are disabled until the request state is reconciled. Requests still deny at their deadlines.`;
    updateTimes();
  }

  function announce(message) {
    elements.actionStatus.textContent = "";
    window.setTimeout(() => {
      elements.actionStatus.textContent = message;
    }, 0);
  }

  function applySnapshot(snapshot) {
    approvals.pending.clear();
    approvals.recent.clear();
    for (const approval of Array.isArray(snapshot?.pending) ? snapshot.pending : []) {
      const id = requestID(approval);
      if (id) approvals.pending.set(id, approval);
    }
    for (const approval of Array.isArray(snapshot?.recent) ? snapshot.recent : []) {
      const id = requestID(approval);
      if (id) {
        approvals.pending.delete(id);
        approvals.recent.set(id, approval);
      }
    }
    for (const id of feedback.keys()) {
      if (!approvals.pending.has(id)) feedback.delete(id);
    }
    grants = Array.isArray(snapshot?.grants) ? snapshot.grants : [];
    render();
    approvals.pending.forEach(notify);
  }

  function applyPending(approval) {
    const id = requestID(approval);
    if (!id) return;
    const isNew = !approvals.pending.has(id);
    approvals.recent.delete(id);
    approvals.pending.set(id, approval);
    render();
    if (isNew) {
      notify(approval);
      // Off the Pending view only the badge would change, so say it out loud.
      if (view === "pending") announce(`Approval requested for ${commandTitle(approval)}`);
      else notice(`Approval requested for ${commandTitle(approval)}`);
    }
  }

  // A resolved request leaves the card; the next pending one takes its place and re-arms.
  function applyResolved(approval) {
    const id = requestID(approval);
    if (!id) return;
    const shown = id === selectedID && approvals.pending.has(id);
    const focusReview = shown && $("pending-actions").contains(document.activeElement);
    if (shown) selectedID = neighbourOf(id);
    approvals.pending.delete(id);
    approvals.recent.set(id, approval);
    feedback.delete(id);
    render();
    if (focusReview) $("review").focus({ preventScroll: true });
    notice(`${stateLabel(approval.state)}: ${commandTitle(approval)}`, approval.state);
  }

  function sortedPending() {
    return [...approvals.pending.values()].sort((left, right) => {
      return timestamp(left.created_at) - timestamp(right.created_at);
    });
  }

  function neighbourOf(id) {
    const pending = sortedPending();
    const index = pending.findIndex((approval) => requestID(approval) === id);
    return requestID(pending[index + 1] ?? pending[index - 1]);
  }

  function applyGrants(list) {
    grants = Array.isArray(list) ? list : [];
    render();
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

  function connectEvents() {
    if (eventSource) eventSource.close();
    setConnection("connecting", "Connecting");
    eventSource = new EventSource("/api/v1/events");
    eventSource.addEventListener("open", () => {
      // A transport connection alone does not reconcile missed resolutions.
      stateVersion++;
      setConnection("connecting", "Reconciling");
    });
    eventSource.addEventListener("snapshot", (event) => {
      if (parseEvent(event, applySnapshot)) setConnection("online", "Connected locally");
    });
    eventSource.addEventListener("pending", (event) => parseEvent(event, applyPending));
    eventSource.addEventListener("resolved", (event) => parseEvent(event, applyResolved));
    eventSource.addEventListener("grants", (event) => parseEvent(event, applyGrants));
    eventSource.addEventListener("error", () => {
      stateVersion++;
      setConnection("offline", "Reconnecting");
    });
  }

  function parseEvent(event, apply) {
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

  function selectRequest(id) {
    selectedID = id;
    render();
  }

  function viewFromHash() {
    const name = window.location.hash.slice(1);
    return views.includes(name) ? name : "";
  }

  function setView(name) {
    if (name === view) return;
    view = name;
    openedID = "";
    rowIndex = 0;
    filterText = "";
    $("filter").value = "";
    render();
  }

  // The hash keeps the view across reloads; hashchange catches links and the back button.
  function showView(name) {
    if (window.location.hash !== `#${name}`) window.location.hash = name;
    setView(name);
  }

  function shownApproval() {
    if (view === "pending") return approvals.pending.get(selectedID);
    if (view === "history") return approvals.recent.get(openedID);
    return undefined;
  }

  function openHistory(id) {
    openedID = id;
    render();
    $("review").focus({ preventScroll: true });
  }

  function closeHistory() {
    openedID = "";
    render();
    rows[rowIndex]?.element.focus({ preventScroll: true });
  }

  function replaceSelectors(container, items) {
    const active = document.activeElement;
    const focused = container.contains(active) ? active.closest("[data-request-id]") : null;
    const focusedID = focused?.dataset.requestId ?? "";
    container.replaceChildren(...items);
    if (focusedID) {
      const replacement = container.querySelector(`[data-request-id="${CSS.escape(focusedID)}"]`);
      (replacement ?? $("review")).focus({ preventScroll: true });
    }
  }

  function selector(approval, className) {
    const button = element("button", className);
    const id = requestID(approval);
    button.type = "button";
    button.dataset.requestId = id;
    button.setAttribute("aria-pressed", String(id === selectedID));
    button.setAttribute("aria-controls", "sheet");
    button.addEventListener("click", () => selectRequest(id));
    return button;
  }

  function render() {
    const pending = sortedPending();
    if (!approvals.pending.has(selectedID)) selectedID = requestID(pending[0]);
    if (!approvals.recent.has(openedID)) openedID = "";
    $("pending-count").textContent = String(pending.length);
    $("grant-count").textContent = String(grants.length);
    for (const name of views) {
      if (name === view) $(`view-${name}`).setAttribute("aria-current", "page");
      else $(`view-${name}`).removeAttribute("aria-current");
    }
    $("queue-items").hidden = view !== "pending";
    $("list-tools").hidden = view === "pending" || !!openedID;
    $("back").hidden = !openedID;
    replaceSelectors(
      $("queue-items"),
      pending.map((approval, index) => {
        const button = selector(approval, "queue-item");
        button.dataset.deadline = approval.deadline;
        button.dataset.created = approval.created_at;
        const command = element("span", "queue-command");
        if (index < 9) command.append(textElement("kbd", "hint", String(index + 1)), " ");
        command.append(commandTitle(approval));
        button.append(
          element("span", "deadline-bar"),
          command,
          textElement("span", "clock text-small", ""),
          textElement(
            "span",
            "queue-meta text-small text-muted",
            sessionLabel(commandRequest(approval).session_id, approval.session),
          ),
        );
        return button;
      }),
    );
    renderList();
    renderSheet(shownApproval());
    $("empty-sheet").hidden = view !== "pending" || pending.length > 0;
    updateTimes();
  }

  // Sessions and History are flat row lists for j, k, x and Enter, whatever their grouping.
  function renderList() {
    const sessions = view === "sessions";
    const history = view === "history" && !openedID;
    rows = [];
    $("session-groups").hidden = !sessions;
    $("history-items").hidden = !history;
    if (sessions) replaceSelectors($("session-groups"), sessionGroups());
    if (history) replaceSelectors($("history-items"), historyRows());
    rowIndex = Math.max(0, Math.min(rowIndex, rows.length - 1));
    markCurrentRow();
    $("list-empty").hidden = !(sessions || history) || rows.length > 0;
    $("list-empty").textContent = filterText.trim()
      ? `Nothing matches "${safeInline(filterText, 60)}".`
      : sessions
        ? "No session approvals."
        : "No decisions yet.";
  }

  function markCurrentRow() {
    rows.forEach((row, index) => {
      if (index === rowIndex) row.element.setAttribute("aria-current", "true");
      else row.element.removeAttribute("aria-current");
    });
  }

  function moveRow(step) {
    if (rows.length === 0) return false;
    rowIndex = Math.max(0, Math.min(rows.length - 1, rowIndex + step));
    markCurrentRow();
    rows[rowIndex].element.focus({ preventScroll: true });
    rows[rowIndex].element.scrollIntoView({ block: "nearest" });
    return true;
  }

  function addRow(element, row) {
    const index = rows.push({ element, ...row }) - 1;
    element.addEventListener("focusin", () => {
      rowIndex = index;
      markCurrentRow();
    });
  }

  function matchesFilter(...values) {
    const query = filterText.trim().toLowerCase();
    return (
      !query ||
      values.some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(query),
      )
    );
  }

  function sessionGroups() {
    const bySession = new Map();
    for (const grant of grants) {
      const id = String(grant.session_id ?? "");
      if (!bySession.has(id)) bySession.set(id, []);
      bySession.get(id).push(grant);
    }
    const groups = [];
    for (const [sessionID, sessionGrants] of bySession) {
      const record = sessionGrants.find((grant) => grant.session)?.session;
      const label = sessionLabel(sessionID, record);
      const where = sessionWhere(record);
      const shown = sessionGrants.filter((grant) =>
        matchesFilter(label, where, displayArgs(grant.args)),
      );
      if (shown.length === 0) continue;
      const group = element("section", "session-group");
      const head = element("div", "session-head row");
      const revokeAll = element("button", "quiet text-small");
      revokeAll.type = "button";
      revokeAll.append(textElement("kbd", "hint", "⇧X"), ` Revoke all ${sessionGrants.length}`);
      revokeAll.setAttribute("aria-label", `Revoke all session approvals for ${label}`);
      revokeAll.addEventListener("click", () => void revoke(sessionGrants.map(grantID)));
      head.append(sessionTitle(label, where, record?.started), revokeAll);
      group.append(head, ...shown.map(grantRow));
      groups.push(group);
    }
    return groups;
  }

  function sessionTitle(label, where, started) {
    const title = element("div", "session-title");
    title.append(textElement("h2", "session-name break-anywhere", label));
    const meta = element("p", "text-small text-muted break-anywhere");
    if (where) meta.append(where);
    if (Number.isFinite(timestamp(started))) {
      const time = textElement("time", "", shortTime(started));
      time.dateTime = String(started);
      time.title = fullTime(started);
      meta.append(where ? ", started " : "Started ", time);
    }
    if (meta.hasChildNodes()) title.append(meta);
    return title;
  }

  function grantUsage(grant) {
    const uses = Number(grant.uses) || 0;
    if (uses === 0) return "unused";
    const times = uses === 1 ? "once" : `${uses} times`;
    return `used ${times}, last ${shortTime(grant.last_used_at)}`;
  }

  function grantID(grant) {
    return String(grant.id ?? "");
  }

  function grantRow(grant) {
    const row = element("div", "list-row grant-row");
    row.tabIndex = -1;
    row.dataset.requestId = grantID(grant);
    const revokeButton = element("button", "quiet text-small");
    revokeButton.type = "button";
    revokeButton.append(textElement("kbd", "hint", "x"), " Revoke");
    revokeButton.setAttribute(
      "aria-label",
      `Revoke session approval for ${safeInline(displayArgs(grant.args), 100)}`,
    );
    revokeButton.addEventListener("click", () => void revoke([grantID(grant)]));
    row.append(
      textElement("code", "break-anywhere pre-wrap", displayArgs(grant.args)),
      textElement(
        "span",
        "text-small text-muted",
        `approved ${shortTime(grant.created_at)}, ${grantUsage(grant)}`,
      ),
      revokeButton,
    );
    addRow(row, { grant });
    return row;
  }

  function historyRows() {
    return [...approvals.recent.values()]
      .sort((left, right) => {
        return timestamp(right.resolution?.resolved_at) - timestamp(left.resolution?.resolved_at);
      })
      .filter((approval) => {
        const request = commandRequest(approval);
        return matchesFilter(
          displayArgs(request.args),
          sessionLabel(request.session_id, approval.session),
          stateLabel(approval.state),
          approval.resolution?.reason,
        );
      })
      .map(historyRow);
  }

  function historyRow(approval) {
    const request = commandRequest(approval);
    const id = requestID(approval);
    const button = element("button", "list-row history-row");
    button.type = "button";
    button.dataset.requestId = id;
    const resolved = approval.resolution?.resolved_at;
    const time = textElement("time", "text-small text-muted", shortTime(resolved));
    time.dateTime = String(resolved ?? "");
    time.title = fullTime(resolved);
    button.setAttribute(
      "aria-label",
      `${stateLabel(approval.state)}: ${commandTitle(approval)}, ${fullTime(resolved)}`,
    );
    const how = safeInline(approval.resolution?.reason, 80);
    const label = sessionLabel(request.session_id, approval.session);
    button.append(
      textElement("span", `mini-stamp text-small ${approval.state}`, stateLabel(approval.state)),
      textElement("code", "break-anywhere", safeInline(displayArgs(request.args), 200)),
      time,
      textElement("span", "history-meta text-small text-muted", how ? `${label}, ${how}` : label),
    );
    button.addEventListener("click", () => openHistory(id));
    addRow(button, { approval });
    return button;
  }

  function metadataItem(label, value) {
    const row = element("div", "");
    const dd = element("dd", "break-anywhere");
    dd.append(
      value instanceof Node
        ? value
        : textElement("code", "text-small pre-wrap", String(value ?? "—")),
    );
    row.append(textElement("dt", "text-small text-muted", label), dd);
    return row;
  }

  // Long arguments are clipped, never hidden: the button says how much is left out.
  function argumentChips(arg, index) {
    const text = displayArg(arg);
    const characters = Array.from(text);
    const chip = textElement("code", index === 0 ? "chip chip-command" : "chip", text);
    if (characters.length <= clipLength) return [chip];
    const head = `${characters.slice(0, clipLength).join("")}…`;
    const label = `+${characters.length - clipLength} chars`;
    const toggle = textElement("button", "chip-toggle text-small", label);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      chip.textContent = expanded ? head : text;
      toggle.textContent = expanded ? label : "Show less";
      toggle.setAttribute("aria-expanded", String(!expanded));
    });
    chip.textContent = head;
    return [chip, toggle];
  }

  function argumentTable(args) {
    const table = element("table", "argv-table");
    table.setAttribute("aria-label", "Argument array, JSON-escaped values");
    table.append(
      ...args.map((arg, index) => {
        const row = element("tr", "");
        const th = textElement("th", "text-muted", `argv[${index}]`);
        th.scope = "row";
        const td = element("td", "");
        td.append(textElement("code", "pre-wrap", JSON.stringify(arg)));
        row.append(th, td);
        return row;
      }),
    );
    return table;
  }

  // Only what differs from a plain agent request reaching the default rule.
  function exceptionLines(request) {
    const lines = [];
    if (request.caller !== "session") {
      const line = element("p", "break-anywhere");
      line.append(
        "Launched by ",
        textElement("code", "", safeInline(request.caller, 100)),
        ", not directly by the agent.",
      );
      lines.push(line);
    }
    if (request.reason) {
      lines.push(
        textElement("p", "exception-reason break-anywhere", safeInline(request.reason, 300)),
      );
    }
    if (request.reason || request.intercept_rule !== "invocation_policy.default") {
      const line = element("p", "text-small break-anywhere");
      line.append("Matched ", textElement("code", "", rulePath(request)));
      lines.push(line);
    }
    return lines;
  }

  // Request content never changes, so it is only rebuilt when another request is shown.
  function renderRequest(approval) {
    const request = commandRequest(approval);
    const args = Array.isArray(request.args) ? request.args : [];
    $("details").open = false;
    $("request-title").textContent = commandTitle(approval);
    const label = sessionLabel(request.session_id, approval.session);
    $("session").textContent = label;
    $("session-where").textContent = sessionWhere(approval.session);
    $("session-where").hidden = !approval.session;
    $("scope").textContent = `Session approval covers this exact argv in ${label}`;
    $("command").replaceChildren(...args.flatMap(argumentChips));
    const exception = exceptionLines(request);
    $("exception").replaceChildren(...exception);
    $("exception").hidden = exception.length === 0;
    $("technical-data").replaceChildren(
      metadataItem("Arguments", argumentTable(args)),
      metadataItem("Command", JSON.stringify(request.command)),
      metadataItem("Caller", request.caller),
      metadataItem("Rule", rulePath(request)),
      metadataItem("Reason", request.reason || "—"),
      metadataItem("Session ID", request.session_id),
      ...sessionItems(approval.session),
      metadataItem("Request ID", requestID(approval)),
      metadataItem("Shim PID", request.child_pid),
      metadataItem("Backend", approval.envelope?.backend),
      metadataItem("Received", approval.created_at),
      metadataItem("Deadline", approval.deadline),
    );
  }

  function sessionItems(record) {
    if (!record) return [];
    return [
      metadataItem("Session command", displayArgs(record.command)),
      metadataItem("Profile", record.profile || "—"),
      metadataItem("Working directory", record.workdir),
      metadataItem("Session started", record.started),
    ];
  }

  function renderSheet(approval) {
    $("sheet").hidden = !approval;
    if (!approval) {
      renderedID = "";
      return;
    }
    const id = requestID(approval);
    const waiting = approval.state === "pending";
    if (id !== renderedID) {
      renderRequest(approval);
      renderedID = id;
      if (waiting) arm();
    }
    const sheet = $("sheet");
    sheet.dataset.state = approval.state;
    sheet.setAttribute("aria-busy", String(sending.has(id)));
    if (waiting) {
      sheet.dataset.deadline = approval.deadline;
      sheet.dataset.created = approval.created_at;
    } else {
      delete sheet.dataset.deadline;
      delete sheet.dataset.created;
      sheet.classList.remove("urgent");
      $("clock").textContent =
        `${stateLabel(approval.state)} ${shortTime(approval.resolution?.resolved_at)}`;
    }
    $("pending-actions").hidden = !waiting;
    $("terminal").hidden = waiting;
    $("decision-feedback").textContent = feedback.get(id) ?? "";
    if (!waiting) {
      $("stamp").className = `stamp ${approval.state}`;
      $("stamp").textContent = stateLabel(approval.state);
      const session = approval.resolution?.scope === "session";
      $("terminal-title").textContent =
        approval.state !== "granted"
          ? "This request did not receive approval."
          : session
            ? "Approval granted for this nono session."
            : "Approval granted for this invocation.";
      $("terminal-reason").textContent = approval.resolution?.reason ?? "";
    }
  }

  function canDecide(approval) {
    return (
      connected &&
      approval?.state === "pending" &&
      !sending.has(requestID(approval)) &&
      timestamp(approval.deadline) > Date.now()
    );
  }

  // The request ID is pinned when the user acts, never read back from the selection later.
  async function decide(id, decision, scope = "once") {
    const approval = approvals.pending.get(id);
    if (!canDecide(approval)) return;
    sending.add(id);
    feedback.set(id, decision === "granted" ? "Approving…" : "Denying…");
    const reasons = {
      once: decision === "granted" ? "Approved once in browser" : "Denied in browser",
      session: "Approved for session in browser",
    };
    render();
    try {
      const response = await fetch(`/api/v1/approvals/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        credentials: "omit",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ decision, scope, reason: reasons[scope] }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(payload.error || `decision returned HTTP ${response.status}`);
      if (payload.state !== decision || !Number.isFinite(timestamp(payload.resolved_at))) {
        throw new Error("invalid decision response");
      }
      stateVersion++;
      if (approvals.pending.has(id))
        applyResolved({ ...approval, state: payload.state, resolution: payload });
    } catch (error) {
      stateVersion++;
      feedback.set(id, `Could not confirm decision: ${safeInline(error.message, 160)}`);
      setConnection("connecting", "Reconciling");
      announce("The decision could not be confirmed. Reconciling the request state.");
      void refreshSnapshot();
    } finally {
      sending.delete(id);
      render();
    }
  }

  // One DELETE per grant; a session holds at most as many grants as the store keeps.
  async function revoke(ids) {
    if (ids.length === 0 || ids.some((id) => !id)) return;
    if (!connected) {
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
      notice(`Could not revoke session approval: ${safeInline(error.message, 160)}`);
    } finally {
      void refreshSnapshot();
    }
  }

  function arm() {
    if (queued) cancelQueued();
    armedAt = performance.now() + armMilliseconds;
    const actions = $("pending-actions").querySelector(".actions");
    actions.classList.remove("arming");
    void actions.offsetWidth; // Restarts the fill animation.
    actions.classList.add("arming");
    window.clearTimeout(armTimer);
    armTimer = window.setTimeout(() => actions.classList.remove("arming"), armMilliseconds);
  }

  function isArmed() {
    return performance.now() >= armedAt;
  }

  function approveByClick(scope) {
    if (!isArmed()) {
      notice("Not armed yet. Wait for the bar to fill.");
      return;
    }
    void decide(selectedID, "granted", scope);
  }

  // Fires after a quiet window, so typing that lands in the browser can't approve.
  function approveByKey(scope, gap) {
    const id = selectedID;
    const button = $(scope === "session" ? "approve-session" : "approve");
    if (button.disabled) return;
    if (gap < quietMilliseconds) {
      notice("Typing detected. Shortcut ignored.");
      return;
    }
    if (!isArmed()) {
      notice("Not armed yet. Wait for the bar to fill.");
      return;
    }
    button.classList.add("pressing");
    queued = {
      button,
      timer: window.setTimeout(() => {
        queued = undefined;
        button.classList.remove("pressing");
        void decide(id, "granted", scope);
      }, quietMilliseconds),
    };
  }

  function cancelQueued() {
    window.clearTimeout(queued.timer);
    queued.button.classList.remove("pressing");
    queued = undefined;
  }

  function moveSelection(step) {
    const pending = sortedPending();
    if (pending.length === 0) return false;
    const index = pending.findIndex((approval) => requestID(approval) === selectedID);
    const next = index < 0 ? 0 : Math.max(0, Math.min(pending.length - 1, index + step));
    selectRequest(requestID(pending[next]));
    return true;
  }

  function toggleHelp() {
    if ($("help").open) $("help").close();
    else $("help").showModal();
  }

  function handleKey(key, shift, gap) {
    if (key === "?") {
      toggleHelp();
      return true;
    }
    if ($("help").open) return false;
    const viewKeys = { p: "pending", s: "sessions", h: "history" };
    if (viewKeys[key]) {
      showView(viewKeys[key]);
      return true;
    }
    if (view !== "pending") return handleListKey(key, shift);
    if (key === "j" || key === "ArrowDown" || key === "ArrowRight") return moveSelection(1);
    if (key === "k" || key === "ArrowUp" || key === "ArrowLeft") return moveSelection(-1);
    if (/^[1-9]$/.test(key)) {
      const target = sortedPending()[Number(key) - 1];
      if (target) selectRequest(requestID(target));
      return true;
    }
    if ($("sheet").hidden) return false;
    if (key === "i") {
      $("details").open = !$("details").open;
      return true;
    }
    if (shownApproval()?.state !== "pending") return false;
    if (key === "n") {
      void decide(selectedID, "denied");
      return true;
    }
    if (key === "y") {
      approveByKey(shift ? "session" : "once", gap);
      return true;
    }
    return false;
  }

  function handleListKey(key, shift) {
    if (openedID) {
      if (key === "Escape") {
        closeHistory();
        return true;
      }
      if (key === "i") {
        $("details").open = !$("details").open;
        return true;
      }
      return false;
    }
    if (key === "/") {
      $("filter").focus();
      return true;
    }
    if (key === "Escape" && filterText) {
      clearFilter();
      return true;
    }
    if (key === "j" || key === "ArrowDown") return moveRow(1);
    if (key === "k" || key === "ArrowUp") return moveRow(-1);
    const row = rows[rowIndex];
    if (!row) return false;
    // A focused row opens itself through its own click.
    if (key === "Enter" && row.approval && document.activeElement === document.body) {
      openHistory(requestID(row.approval));
      return true;
    }
    if (key === "x" && row.grant) {
      const sessionID = row.grant.session_id;
      const chosen = shift ? grants.filter((grant) => grant.session_id === sessionID) : [row.grant];
      void revoke(chosen.map(grantID));
      return true;
    }
    return false;
  }

  function clearFilter() {
    filterText = "";
    $("filter").value = "";
    rowIndex = 0;
    renderList();
  }

  function onKeyDown(event) {
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const now = performance.now();
    const gap = now - lastKeyAt;
    lastKeyAt = now;
    if (queued) {
      cancelQueued();
      notice("Typing detected. Shortcut ignored.");
      event.preventDefault();
      return;
    }
    if (!shortcutsOn || event.repeat) return;
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

  function applyShortcuts() {
    document.documentElement.dataset.shortcuts = shortcutsOn ? "on" : "off";
    $("shortcuts").checked = shortcutsOn;
    const keys = { deny: "n", "approve-session": "Shift+Y", approve: "y" };
    for (const [id, key] of Object.entries(keys)) {
      if (shortcutsOn) $(id).setAttribute("aria-keyshortcuts", key);
      else $(id).removeAttribute("aria-keyshortcuts");
    }
  }

  // Visible confirmation; the live region reads out the same text.
  function notice(message, state = "") {
    const toast = $("toast");
    toast.textContent = message;
    toast.dataset.state = state;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3000);
    announce(message);
  }

  // Tabs and the card carry their deadline; the bar drains and the clock counts down.
  function updateTimes() {
    const now = Date.now();
    document.querySelectorAll("[data-deadline]").forEach((item) => {
      const deadline = timestamp(item.dataset.deadline);
      const remaining = Math.max(0, deadline - now);
      const total = deadline - timestamp(item.dataset.created);
      const left = total > 0 ? Math.min(1, remaining / total) : 0;
      item.style.setProperty("--left", String(left));
      item.classList.toggle("urgent", remaining <= 10000);
      const clock = item.querySelector(".clock");
      if (clock) clock.textContent = duration(remaining);
    });
    const approval = approvals.pending.get(selectedID);
    $("approve").disabled = !canDecide(approval);
    $("approve-session").disabled = !canDecide(approval);
    $("deny").disabled = !canDecide(approval);
  }

  function shortTime(value) {
    const parsed = timestamp(value);
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "—";
  }

  function fullTime(value) {
    const parsed = timestamp(value);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "—";
  }

  function stateLabel(state) {
    return (
      {
        pending: "Waiting",
        granted: "Approved",
        denied: "Denied",
        expired: "Expired",
        canceled: "Canceled",
      }[state] ?? "Resolved"
    );
  }
  function configureNotifications() {
    if (!("Notification" in window)) return;
    updateNotificationButton();
    elements.notifications.addEventListener("click", async () => {
      try {
        await Notification.requestPermission();
      } catch (error) {
        console.warn("Could not request notification permission", error);
      }
      updateNotificationButton();
    });
  }

  // The button only shows while there is something to do or to know.
  function updateNotificationButton() {
    elements.notifications.hidden = Notification.permission === "granted";
    switch (Notification.permission) {
      case "granted":
        break;
      case "denied":
        elements.notifications.textContent = "Notifications blocked";
        elements.notifications.disabled = true;
        break;
      default:
        elements.notifications.textContent = "Enable notifications";
        elements.notifications.disabled = false;
    }
  }

  function notify(approval) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }
    if (document.visibilityState === "visible" && document.hasFocus()) {
      return;
    }

    const request = commandRequest(approval);
    const summary = (Array.isArray(request.args) ? request.args : [])
      .map((argument) => safeInline(argument, 80))
      .join(" ");
    const id = requestID(approval);
    if (notifiedIDs.has(id)) {
      return;
    }
    try {
      const notification = new Notification(
        `Approval requested: ${safeInline(request.command, 40) || "command"}`,
        {
          body: truncate(summary || "Open the dashboard to review the request.", 180),
          tag: `nono-hitl-${truncate(id, 100)}`,
        },
      );
      rememberNotification(id);
      notification.addEventListener("click", () => {
        window.focus();
        notification.close();
        if (approvals.pending.has(id)) {
          showView("pending");
          selectRequest(id);
          const card = $("sheet");
          const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth";
          card.scrollIntoView({ behavior, block: "center" });
          $("deny").focus({ preventScroll: true });
        }
      });
    } catch (error) {
      console.warn("Could not display approval notification", error);
    }
  }

  function rememberNotification(id) {
    notifiedIDs.add(id);
    notificationOrder.push(id);
    if (notificationOrder.length > 512) {
      notifiedIDs.delete(notificationOrder.shift());
    }
  }

  function duration(milliseconds) {
    if (!Number.isFinite(milliseconds)) {
      return "—";
    }
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }

  function timestamp(value) {
    return Date.parse(String(value ?? ""));
  }

  function safeInline(value, maximum) {
    const sanitized = Array.from(String(value ?? ""), (character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
    }).join("");
    return truncate(sanitized.trim(), maximum);
  }

  function truncate(value, maximum) {
    const characters = Array.from(String(value));
    return characters.length <= maximum
      ? characters.join("")
      : `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
  }

  function element(tagName, className) {
    const item = document.createElement(tagName);
    item.className = className;
    return item;
  }

  function textElement(tagName, className, text) {
    const item = element(tagName, className);
    item.textContent = text;
    return item;
  }

  $("listener").textContent = window.location.host;
  $("help-open").addEventListener("click", () => $("help").showModal());
  $("help-close").addEventListener("click", () => $("help").close());
  $("approve").addEventListener("click", () => approveByClick("once"));
  $("approve-session").addEventListener("click", () => approveByClick("session"));
  $("deny").addEventListener("click", () => void decide(selectedID, "denied"));
  $("back").addEventListener("click", closeHistory);
  $("filter").addEventListener("input", () => {
    filterText = $("filter").value;
    rowIndex = 0;
    renderList();
  });
  $("filter").addEventListener("keydown", (event) => {
    if (event.key === "Escape") clearFilter();
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      $("filter").blur();
    }
  });
  window.addEventListener("hashchange", () => {
    const name = viewFromHash();
    if (name) setView(name);
  });
  $("shortcuts").addEventListener("change", () => {
    shortcutsOn = $("shortcuts").checked;
    try {
      localStorage.setItem(shortcutsKey, shortcutsOn ? "on" : "off");
    } catch {}
    applyShortcuts();
  });
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("focus", arm);
  view = viewFromHash() || "pending";
  applyShortcuts();
  configureNotifications();
  render();
  setConnection("connecting", "Connecting");
  void refreshSnapshot().finally(connectEvents);
  window.setInterval(updateTimes, 1000);
  window.setInterval(() => void refreshSnapshot(), 15000);
  window.addEventListener("online", () => void refreshSnapshot());
  window.addEventListener("blur", () => approvals.pending.forEach(notify));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshSnapshot();
  });
});
