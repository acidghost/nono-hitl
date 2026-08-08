(() => {
	const elements = {
		actionStatus: document.getElementById("action-status"),
		connection: document.getElementById("connection-status"),
		connectionLabel: document.querySelector(".connection-label"),
		notifications: document.getElementById("notifications-button"),
		pendingCount: document.getElementById("pending-count"),
		pendingEmpty: document.getElementById("pending-empty"),
		pendingList: document.getElementById("pending-list"),
		recentEmpty: document.getElementById("recent-empty"),
		recentList: document.getElementById("recent-list"),
	};

	const approvals = {
		pending: new Map(),
		recent: new Map(),
	};

	const notifiedIDs = new Set();
	const notificationOrder = [];
	let eventSource;

	function requestID(approval) {
		return String(approval?.envelope?.request?.request_id ?? "");
	}

	function commandRequest(approval) {
		return approval?.envelope?.request ?? {};
	}

	function setConnection(state, label) {
		elements.connection.dataset.state = state;
		elements.connectionLabel.textContent = label;
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
			if (id) {
				approvals.pending.set(id, approval);
			}
		}
		for (const approval of Array.isArray(snapshot?.recent) ? snapshot.recent : []) {
			const id = requestID(approval);
			if (id) {
				approvals.pending.delete(id);
				approvals.recent.set(id, approval);
			}
		}
		render();
		approvals.pending.forEach(notify);
	}

	function applyPending(approval) {
		const id = requestID(approval);
		if (!id) {
			return;
		}
		const isNew = !approvals.pending.has(id);
		approvals.recent.delete(id);
		approvals.pending.set(id, approval);
		render();
		if (isNew) {
			notify(approval);
			announce(`Approval requested for ${safeInline(commandRequest(approval).command, 80)}`);
		}
	}

	function applyResolved(approval) {
		const id = requestID(approval);
		if (!id) {
			return;
		}
		approvals.pending.delete(id);
		approvals.recent.set(id, approval);
		render();
		announce(`Request ${safeInline(id, 80)} was ${stateLabel(approval.state)}`);
	}

	async function refreshSnapshot() {
		try {
			const response = await fetch("/api/v1/approvals", {
				credentials: "omit",
				headers: { Accept: "application/json" },
			});
			if (!response.ok) {
				throw new Error(`snapshot returned HTTP ${response.status}`);
			}
			applySnapshot(await response.json());
		} catch (error) {
			setConnection("offline", "Disconnected");
			console.warn("Could not refresh approval snapshot", error);
		}
	}

	function connectEvents() {
		if (eventSource) {
			eventSource.close();
		}

		setConnection("connecting", "Connecting");
		eventSource = new EventSource("/api/v1/events");
		eventSource.addEventListener("open", () => {
			setConnection("online", "Connected");
		});
		eventSource.addEventListener("snapshot", (event) => {
			parseEvent(event, applySnapshot);
		});
		eventSource.addEventListener("pending", (event) => {
			parseEvent(event, applyPending);
		});
		eventSource.addEventListener("resolved", (event) => {
			parseEvent(event, applyResolved);
		});
		eventSource.addEventListener("error", () => {
			setConnection("connecting", "Reconnecting");
		});
	}

	function parseEvent(event, apply) {
		try {
			apply(JSON.parse(event.data));
		} catch (error) {
			console.warn("Ignored malformed approval event", error);
			void refreshSnapshot();
		}
	}

	function render() {
		const pending = [...approvals.pending.values()].sort((left, right) => {
			return timestamp(left.created_at) - timestamp(right.created_at);
		});
		const recent = [...approvals.recent.values()].sort((left, right) => {
			return timestamp(right.resolution?.resolved_at) - timestamp(left.resolution?.resolved_at);
		});

		elements.pendingList.replaceChildren(...pending.map(renderPending));
		elements.pendingCount.textContent = String(pending.length);
		elements.pendingEmpty.hidden = pending.length !== 0;

		elements.recentList.replaceChildren(...recent.map(renderRecent));
		elements.recentEmpty.hidden = recent.length !== 0;
		updateTimes();
	}

	function renderPending(approval) {
		const request = commandRequest(approval);
		const article = element("article", "approval-card approval-card-pending");
		article.tabIndex = -1;
		article.dataset.requestId = requestID(approval);

		const top = element("div", "card-top");
		const titleGroup = element("div", "card-title-group");
		titleGroup.append(
			badge("pending", "Waiting"),
			textElement("h3", "command-title", safeInline(request.command, 256) || "Command request"),
		);
		top.append(titleGroup, pendingClock(approval));

		article.append(top, commandDetails(approval), metadata(approval));

		const feedback = textElement("p", "decision-feedback", "");
		feedback.setAttribute("role", "status");
		const actions = element("div", "decision-actions");
		const deny = actionButton("Deny", "button button-deny", approval, "denied", feedback);
		const grant = actionButton(
			"Approve once",
			"button button-approve",
			approval,
			"granted",
			feedback,
		);
		actions.append(deny, grant);
		article.append(feedback, actions);
		return article;
	}

	function renderRecent(approval) {
		const request = commandRequest(approval);
		const article = element("article", "approval-card approval-card-recent");
		const top = element("div", "card-top");
		const titleGroup = element("div", "card-title-group");
		titleGroup.append(
			badge(approval.state, stateLabel(approval.state)),
			textElement("h3", "command-title", safeInline(request.command, 256) || "Command request"),
		);
		top.append(titleGroup, resolvedClock(approval));
		article.append(top, commandDetails(approval), metadata(approval));

		const reason = approval.resolution?.reason;
		if (reason) {
			const resolution = element("div", "resolution-reason");
			resolution.append(textElement("span", "metadata-label", "Resolution reason"));
			resolution.append(textElement("p", "metadata-value", reason));
			article.append(resolution);
		}
		return article;
	}

	function commandDetails(approval) {
		const request = commandRequest(approval);
		const details = element("div", "command-details");

		const command = element("div", "detail-row");
		command.append(textElement("span", "detail-label", "Command"));
		const commandValue = textElement("code", "command-token", String(request.command ?? ""));
		command.append(commandValue);

		const argumentsRow = element("div", "detail-row");
		argumentsRow.append(textElement("span", "detail-label", "Arguments"));
		const argumentsList = element("ol", "argument-list");
		const args = Array.isArray(request.args) ? request.args : [];
		args.forEach((argument, index) => {
			const item = element("li", "argument-item");
			item.append(
				textElement("span", "argument-index", String(index)),
				textElement("code", "argument-token", String(argument)),
			);
			argumentsList.append(item);
		});
		argumentsRow.append(argumentsList);
		details.append(command, argumentsRow);
		return details;
	}

	function metadata(approval) {
		const request = commandRequest(approval);
		const grid = element("dl", "metadata-grid");
		metadataItem(grid, "Caller", request.caller);
		metadataItem(grid, "Rule", request.intercept_rule);
		metadataItem(grid, "Request reason", request.reason || "—");
		metadataItem(grid, "Session", request.session_id);
		metadataItem(grid, "Child PID", request.child_pid);
		metadataItem(grid, "Request ID", request.request_id);
		return grid;
	}

	function metadataItem(list, label, value) {
		const wrapper = element("div", "metadata-item");
		wrapper.append(
			textElement("dt", "metadata-label", label),
			textElement("dd", "metadata-value", String(value ?? "—")),
		);
		list.append(wrapper);
	}

	function pendingClock(approval) {
		const clock = element("div", "request-clock");
		clock.append(textElement("span", "clock-label", "Time remaining"));
		const value = textElement("time", "clock-value", "—");
		value.dateTime = String(approval.deadline ?? "");
		value.dataset.deadline = String(approval.deadline ?? "");
		value.dataset.createdAt = String(approval.created_at ?? "");
		clock.append(value);
		return clock;
	}

	function resolvedClock(approval) {
		const clock = element("div", "request-clock request-clock-resolved");
		clock.append(textElement("span", "clock-label", "Resolved"));
		const value = textElement("time", "clock-value", "—");
		value.dateTime = String(approval.resolution?.resolved_at ?? "");
		value.dataset.resolvedAt = String(approval.resolution?.resolved_at ?? "");
		clock.append(value);
		return clock;
	}

	function actionButton(label, className, approval, decision, feedback) {
		const button = textElement("button", className, label);
		button.type = "button";
		button.addEventListener("click", () => {
			void decide(approval, decision, feedback, button.closest("article"));
		});
		return button;
	}

	async function decide(approval, decision, feedback, card) {
		const id = requestID(approval);
		const buttons = card.querySelectorAll("button");
		buttons.forEach((button) => {
			button.disabled = true;
		});
		card.setAttribute("aria-busy", "true");
		feedback.textContent = decision === "granted" ? "Approving…" : "Denying…";

		try {
			const response = await fetch(`/api/v1/approvals/${encodeURIComponent(id)}/decision`, {
				method: "POST",
				credentials: "omit",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					decision,
					reason: decision === "granted" ? "Approved once in browser" : "Denied in browser",
				}),
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw new Error(payload.error || `decision returned HTTP ${response.status}`);
			}
			feedback.textContent = "Decision recorded.";
			announce(`${decision === "granted" ? "Approved" : "Denied"} ${safeInline(id, 80)}`);
		} catch (error) {
			feedback.textContent = `Could not record decision: ${safeInline(error.message, 160)}`;
			buttons.forEach((button) => {
				button.disabled = false;
			});
			card.removeAttribute("aria-busy");
			announce("The decision was not recorded. Review the request and try again.");
			void refreshSnapshot();
		}
	}

	function updateTimes() {
		const now = Date.now();
		document.querySelectorAll("[data-deadline]").forEach((item) => {
			const deadline = timestamp(item.dataset.deadline);
			const created = timestamp(item.dataset.createdAt);
			const remaining = Math.max(0, deadline - now);
			const age = Math.max(0, now - created);
			item.textContent = `${duration(remaining)} · waiting ${duration(age)}`;
			item.closest(".request-clock")?.classList.toggle("clock-urgent", remaining <= 10000);
		});
		document.querySelectorAll("[data-resolved-at]").forEach((item) => {
			const resolved = timestamp(item.dataset.resolvedAt);
			item.textContent = Number.isFinite(resolved)
				? `${new Date(resolved).toLocaleString()} · ${duration(Math.max(0, now - resolved))} ago`
				: "—";
		});
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
				const card = [...document.querySelectorAll(".approval-card-pending")].find((item) => {
					return item.dataset.requestId === id;
				});
				if (card) {
					const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
						? "auto"
						: "smooth";
					card.scrollIntoView({ behavior, block: "center" });
					card.querySelector(".button-deny")?.focus({ preventScroll: true });
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

	function badge(state, label) {
		const allowed = ["pending", "granted", "denied", "expired", "canceled"];
		const normalized = allowed.includes(state) ? state : "canceled";
		return textElement("span", `state-badge state-${normalized}`, label);
	}

	function stateLabel(state) {
		switch (state) {
			case "granted":
				return "Granted";
			case "denied":
				return "Denied";
			case "expired":
				return "Expired";
			case "canceled":
				return "Canceled";
			default:
				return "Resolved";
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

	configureNotifications();
	render();
	void refreshSnapshot().finally(connectEvents);
	window.setInterval(updateTimes, 1000);
	window.setInterval(() => void refreshSnapshot(), 15000);
	window.addEventListener("online", () => void refreshSnapshot());
	window.addEventListener("blur", () => approvals.pending.forEach(notify));
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			void refreshSnapshot();
		}
	});
})();
