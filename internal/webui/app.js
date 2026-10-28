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
  const $ = (id) => document.getElementById(id);
  const elements = { notifications: $("notification"), actionStatus: $("live") };
  const approvals = { pending: new Map(), recent: new Map() };
  let grants = [];
  const sending = new Set();
  const feedback = new Map();
  const notifiedIDs = new Set();
  const notificationOrder = [];
  let selectedID = "";
  let renderedID = "";
  let connected = false;
  let eventSource;
  let stateVersion = 0;
  let snapshotInFlight = false;

  function requestID(approval) {
    return String(approval?.envelope?.request?.request_id ?? "");
  }

  function commandRequest(approval) {
    return approval?.envelope?.request ?? {};
  }

  function selectedApproval() {
    return approvals.pending.get(selectedID) ?? approvals.recent.get(selectedID);
  }

  function commandTitle(approval) {
    const request = commandRequest(approval);
    const args = Array.isArray(request.args) ? request.args : [];
    return safeInline([request.command, ...args.slice(1, 3)].join(" "), 100) || "Command request";
  }

  function sessionLabel(request) {
    return safeInline(request.session_id, 40) || "unknown session";
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
      announce(`Approval requested for ${commandTitle(approval)}`);
    }
  }

  function applyResolved(approval) {
    const id = requestID(approval);
    if (!id) return;
    const focusReview = id === selectedID && $("pending-actions").contains(document.activeElement);
    approvals.pending.delete(id);
    approvals.recent.set(id, approval);
    feedback.delete(id);
    render();
    if (focusReview) $("review").focus({ preventScroll: true });
    announce(`${stateLabel(approval.state)}: ${commandTitle(approval)}`);
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

  function replaceSelectors(container, buttons) {
    const active = document.activeElement;
    const focusedID = container.contains(active) ? active.dataset.requestId : "";
    container.replaceChildren(...buttons);
    if (focusedID) {
      const replacement = buttons.find((button) => button.dataset.requestId === focusedID);
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
    const pending = [...approvals.pending.values()].sort((left, right) => {
      return timestamp(left.created_at) - timestamp(right.created_at);
    });
    const recent = [...approvals.recent.values()].sort((left, right) => {
      return timestamp(right.resolution?.resolved_at) - timestamp(left.resolution?.resolved_at);
    });
    if (!selectedApproval()) selectedID = requestID(pending[0]);
    $("pending-count").textContent = String(pending.length);
    $("history-empty").hidden = recent.length !== 0;
    replaceSelectors(
      $("queue-items"),
      pending.map((approval) => {
        const button = selector(approval, "queue-item");
        button.dataset.deadline = approval.deadline;
        button.dataset.created = approval.created_at;
        button.append(
          element("span", "deadline-bar"),
          textElement("span", "queue-command", commandTitle(approval)),
          textElement("span", "clock text-small", ""),
          textElement(
            "span",
            "queue-meta text-small text-muted",
            sessionLabel(commandRequest(approval)),
          ),
        );
        return button;
      }),
    );
    replaceSelectors(
      $("history-items"),
      recent.map((approval) => {
        const button = selector(approval, "history-item");
        const resolved = approval.resolution?.resolved_at;
        const time = textElement("time", "history-time text-small text-muted", shortTime(resolved));
        time.dateTime = String(resolved ?? "");
        time.title = fullTime(resolved);
        button.setAttribute(
          "aria-label",
          `${stateLabel(approval.state)}: ${commandTitle(approval)}, ${fullTime(resolved)}`,
        );
        button.append(
          textElement(
            "span",
            `mini-stamp text-small ${approval.state}`,
            stateLabel(approval.state),
          ),
          textElement("span", "history-command break-anywhere", commandTitle(approval)),
          time,
        );
        return button;
      }),
    );
    $("grants-empty").hidden = grants.length !== 0;
    $("grant-items").replaceChildren(...grants.map(grantItem));
    renderSheet(selectedApproval());
    updateTimes();
  }

  function grantItem(grant) {
    const row = element("div", "grant-item");
    const details = element("div", "");
    details.append(
      textElement("code", "break-anywhere pre-wrap", displayArgs(grant.args)),
      textElement(
        "p",
        "text-small text-muted break-anywhere",
        `Session ${safeInline(grant.session_id, 40)} · ${shortTime(grant.created_at)}`,
      ),
    );
    const revokeButton = textElement("button", "quiet text-small", "Revoke");
    revokeButton.type = "button";
    revokeButton.disabled = !connected;
    revokeButton.setAttribute(
      "aria-label",
      `Revoke session approval for ${safeInline(displayArgs(grant.args), 100)}`,
    );
    revokeButton.addEventListener("click", () => void revoke(String(grant.id ?? "")));
    row.append(details, revokeButton);
    return row;
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
    $("session").textContent = sessionLabel(request);
    $("scope").textContent = `Session approval covers this exact argv in ${sessionLabel(request)}`;
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
      metadataItem("Request ID", requestID(approval)),
      metadataItem("Shim PID", request.child_pid),
      metadataItem("Backend", approval.envelope?.backend),
      metadataItem("Received", approval.created_at),
      metadataItem("Deadline", approval.deadline),
    );
  }

  function renderSheet(approval) {
    $("sheet").hidden = !approval;
    $("empty-sheet").hidden = !!approval;
    if (!approval) {
      renderedID = "";
      return;
    }
    const id = requestID(approval);
    if (id !== renderedID) {
      renderRequest(approval);
      renderedID = id;
    }
    const waiting = approval.state === "pending";
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

  async function decide(decision, scope = "once") {
    const approval = selectedApproval();
    if (!canDecide(approval)) return;
    const id = requestID(approval);
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

  async function revoke(id) {
    if (!connected || !id) return;
    try {
      const response = await fetch(`/api/v1/grants/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`revoke returned HTTP ${response.status}`);
      }
      announce("Session approval revoked.");
    } catch (error) {
      announce(`Could not revoke session approval: ${safeInline(error.message, 160)}`);
    } finally {
      void refreshSnapshot();
    }
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
    const approval = selectedApproval();
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
  $("approve").addEventListener("click", () => void decide("granted"));
  $("approve-session").addEventListener("click", () => void decide("granted", "session"));
  $("deny").addEventListener("click", () => void decide("denied"));
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
