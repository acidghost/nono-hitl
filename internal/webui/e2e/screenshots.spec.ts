import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Local review aid only: baselines stay out of git and the suite never runs in CI.

async function shoot(page: Page, name: string) {
  // Toasts hide after three seconds, so one could land in one shot and not the next.
  await page.locator("#toast").evaluate((toast: HTMLElement) => {
    toast.hidden = true;
  });
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    // Countdowns, wall-clock times and the listener port change from run to run.
    mask: [".clock", "time", ".deadline-bar", ".grant-row .text-muted", "#listener"].map(
      (selector) => page.locator(selector),
    ),
    stylePath: join(import.meta.dirname, "screenshots.css"),
  });
}

test.beforeEach(async ({ hitl }) => {
  await hitl.addSession("otter", {
    name: "brave-otter",
    command: ["/usr/local/bin/claude"],
    profile: "claude-code",
    workdir: "/home/dev/nono-hitl",
    started: "2026-10-29T09:00:00Z",
    status: "running",
  });
  await hitl.addSession("heron", {
    name: "quiet-heron",
    command: ["/usr/local/bin/codex"],
    profile: "codex",
    workdir: "/home/dev/website",
    started: "2026-10-29T09:30:00Z",
    status: "running",
  });
});

test("empty", async ({ page, ui }) => {
  await ui.open();
  await shoot(page, "empty");
});

test("one pending", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id } = await hitl.submit(["gh", "pr", "create", "--fill"], { sessionID: "otter" });
  await ui.armed(id);
  await shoot(page, "one-pending");
});

test("several pending", async ({ page, hitl, ui }) => {
  await ui.open();
  const first = await hitl.submit(["gh", "pr", "create", "--fill"], { sessionID: "otter" });
  await hitl.submit(["git", "push", "--force-with-lease"], { sessionID: "otter" });
  await hitl.submit(["npm", "publish"], { sessionID: "heron" });
  await expect(ui.queue).toHaveCount(3);
  await ui.armed(first.id);
  await shoot(page, "several-pending");
});

test("deny note", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id } = await hitl.submit(["gh", "api", "repos/o/r/pulls/42"], { sessionID: "otter" });
  await ui.armed(id);
  await page.keyboard.press("Shift+N");
  await ui.note.fill("use gh pr view 42 instead");
  await shoot(page, "deny-note");
});

test.describe("short deadline", () => {
  test.use({ decisionTimeout: "12s" });

  test("urgent", async ({ page, hitl, ui }) => {
    await ui.open();
    const { id } = await hitl.submit(["terraform", "apply"], { sessionID: "heron" });
    await ui.armed(id);
    await expect(ui.card).toHaveClass(/urgent/);
    await shoot(page, "urgent");
  });
});

test("history, approved and denied", async ({ page, hitl, ui }) => {
  await ui.open();
  const approved = await hitl.submit(["gh", "pr", "create", "--fill"], { sessionID: "otter" });
  await ui.armed(approved.id);
  await ui.approve.click();
  await approved.decision;
  const denied = await hitl.submit(["git", "push", "--force"], { sessionID: "heron" });
  await ui.shown(denied.id);
  await page.keyboard.press("n");
  await denied.decision;

  await page.keyboard.press("h");
  await expect(ui.history).toHaveCount(2);
  await shoot(page, "history");
  await ui.history.filter({ hasText: "Approved" }).click();
  await shoot(page, "approved");
  await page.keyboard.press("Escape");
  await ui.history.filter({ hasText: "Denied" }).click();
  await shoot(page, "denied");
});

test("sessions", async ({ page, hitl, ui }) => {
  await ui.open();
  const requests = [
    { args: ["gh", "pr", "view", "42"], sessionID: "otter" },
    { args: ["git", "push"], sessionID: "otter" },
    { args: ["npm", "test"], sessionID: "heron" },
  ];
  for (const { args, sessionID } of requests) {
    const { id, decision } = await hitl.submit(args, { sessionID });
    await ui.armed(id);
    await page.keyboard.press("Shift+Y");
    await decision;
  }
  // Released by the grant, which counts it as a use.
  await (await hitl.submit(["gh", "pr", "view", "42"], { sessionID: "otter" })).decision;

  await page.keyboard.press("s");
  await expect(ui.grants).toHaveCount(3);
  await shoot(page, "sessions");
});

test("offline", async ({ page, hitl, ui }) => {
  await page.route("**/api/v1/events", (route) => route.abort());
  await hitl.submit(["gh", "pr", "create", "--fill"], { sessionID: "otter" });
  await page.goto("/");
  await expect(ui.offline).toContainText("Connection lost.");
  await expect(ui.queue).toHaveCount(1);
  await expect(page.locator(".actions.arming")).toHaveCount(0);
  await shoot(page, "offline");
});

test("help", async ({ page, ui }) => {
  await ui.open();
  await page.keyboard.press("?");
  await expect(ui.help).toBeVisible();
  await shoot(page, "help");
});
