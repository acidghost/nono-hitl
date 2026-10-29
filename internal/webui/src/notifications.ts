// Desktop notifications for requests that arrive while the dashboard is in the background.
import { commandRequest, requestID, safeInline, truncate } from "./format";
import type { Approval } from "./types";

const notifiedIDs = new Set<string>();
const notificationOrder: string[] = [];

export function notificationsSupported(): boolean {
  return "Notification" in window;
}

// show selects the request and says whether it is still waiting.
export function notify(approval: Approval, show: () => boolean) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;

  const request = commandRequest(approval);
  const summary = (Array.isArray(request.args) ? request.args : [])
    .map((argument) => safeInline(argument, 80))
    .join(" ");
  const id = requestID(approval);
  if (notifiedIDs.has(id)) return;
  try {
    const notification = new Notification(
      `Approval requested: ${safeInline(request.command, 40) || "command"}`,
      {
        body: truncate(summary || "Open the dashboard to review the request.", 180),
        tag: `nono-hitl-${truncate(id, 100)}`,
      },
    );
    remember(id);
    notification.addEventListener("click", () => {
      window.focus();
      notification.close();
      if (!show()) return;
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      document.getElementById("sheet")?.scrollIntoView({ behavior, block: "center" });
      document.getElementById("deny")?.focus({ preventScroll: true });
    });
  } catch (error) {
    console.warn("Could not display approval notification", error);
  }
}

function remember(id: string) {
  notifiedIDs.add(id);
  notificationOrder.push(id);
  if (notificationOrder.length > 512) {
    const oldest = notificationOrder.shift();
    if (oldest !== undefined) notifiedIDs.delete(oldest);
  }
}
