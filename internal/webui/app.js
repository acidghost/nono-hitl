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

  // Display only: these tokens are reported argv, never executable shell text.
  function displayArgs(args) {
    return (Array.isArray(args) ? args : [])
      .map((arg) => (/^[a-zA-Z0-9_./:@#=+-]+$/.test(arg) ? arg : JSON.stringify(arg)))
      .join(" ");
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
    $("pending-count").textContent = `${pending.length} waiting`;
    $("queue-number").textContent = String(pending.length);
    $("queue-empty").hidden = pending.length !== 0;
    $("history-empty").hidden = recent.length !== 0;
    replaceSelectors(
      $("queue-items"),
      pending.map((approval) => {
        const button = selector(approval, "queue-item");
        const clock = textElement("span", "queue-meta text-small text-muted", "");
        clock.dataset.deadline = approval.deadline;
        button.append(
          textElement("span", "queue-command break-anywhere", commandTitle(approval)),
          clock,
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
    dd.append(textElement("code", "text-small pre-wrap", String(value ?? "—")));
    row.append(textElement("dt", "text-small text-muted", label), dd);
    return row;
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
      $("sheet")
        .querySelectorAll("details")
        .forEach((details) => {
          details.open = false;
        });
      renderedID = id;
    }
    const request = commandRequest(approval);
    const waiting = approval.state === "pending";
    const args = Array.isArray(request.args) ? request.args : [];
    $("sheet").dataset.state = approval.state;
    $("sheet").setAttribute("aria-busy", String(sending.has(id)));
    $("request-kind").textContent = waiting ? "Command approval" : "Resolved command request";
    $("request-title").textContent = commandTitle(approval);
    $("command").textContent = displayArgs(args);
    $("argv-count").textContent = `Argument array (${args.length} entries)`;
    $("argv-body").replaceChildren(
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
    $("caller").textContent = request.caller ?? "—";
    $("caller-help").textContent =
      request.caller === "session"
        ? "Caller is the sandboxed session."
        : "Reported caller label; not proof of safety.";
    $("rule").textContent = request.intercept_rule ?? "—";
    $("rule-help").textContent =
      request.intercept_rule === "invocation_policy.default"
        ? "Default invocation policy requires approval."
        : "Reported rule label; inspect the effective profile.";
    $("reason").textContent = request.reason || "No reason supplied.";
    $("technical-data").replaceChildren(
      metadataItem("Command", JSON.stringify(request.command)),
      metadataItem("Request ID", id),
      metadataItem("Session ID", request.session_id),
      metadataItem("Shim PID", request.child_pid),
      metadataItem("Backend", approval.envelope?.backend),
      metadataItem("Received", approval.created_at),
      metadataItem("Deadline", approval.deadline),
    );
    $("pending-actions").hidden = !waiting;
    $("terminal").hidden = waiting;
    $("decision-feedback").textContent = feedback.get(id) ?? "";
    $("clock-label").textContent = waiting
      ? "Denies at deadline"
      : `Resolved ${shortTime(approval.resolution?.resolved_at)}`;
    if (!waiting) {
      $("clock-value").textContent = stateLabel(approval.state);
      $("stamp").className = `stamp text-display ${approval.state}`;
      $("stamp").textContent = stateLabel(approval.state);
      const session = approval.resolution?.scope === "session";
      $("terminal-title").textContent =
        approval.state !== "granted"
          ? "This request did not receive approval."
          : session
            ? "Approval granted for this nono session."
            : "Approval granted for this invocation.";
      $("terminal-reason").textContent = approval.resolution?.reason ?? "";
      $("terminal-note").textContent =
        {
          granted: session
            ? "Identical invocations in this nono session run without asking until revoked."
            : "Execution result is not reported by nono.",
          denied: "Denying this invocation does not change the profile.",
          expired: "The deadline passed without a grant; nono receives a denial.",
          canceled: "The webhook caller disconnected; this request received no grant.",
        }[approval.state] ?? "No approval can be given to a resolved request.";
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

  function updateTimes() {
    const now = Date.now();
    document.querySelectorAll("[data-deadline]").forEach((item) => {
      item.textContent = `${duration(Math.max(0, timestamp(item.dataset.deadline) - now))} remaining`;
    });
    const approval = selectedApproval();
    const waiting = approval?.state === "pending";
    const remaining = timestamp(approval?.deadline) - now;
    $("sheet")
      .querySelector(".clock")
      .classList.toggle("clock-urgent", waiting && remaining <= 10000);
    if (waiting) $("clock-value").textContent = `${duration(Math.max(0, remaining))} remaining`;
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
    if (!("Notification" in window)) {
      elements.notifications.textContent = "Notifications unavailable";
      elements.notifications.disabled = true;
      return;
    }
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

  function updateNotificationButton() {
    switch (Notification.permission) {
      case "granted":
        elements.notifications.textContent = "Notifications enabled";
        elements.notifications.disabled = true;
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
