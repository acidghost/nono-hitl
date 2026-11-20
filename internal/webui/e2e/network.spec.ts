import { expect, test } from "./fixtures";

test("a network request is approved once", async ({ hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submitNetwork("registry.npmjs.org", 443);
  await ui.armed(id);
  await expect(ui.kind).toHaveText("net");
  await expect(ui.destination.first()).toHaveText("registry.npmjs.org:443");
  await expect(ui.hostWarning).toHaveCount(0);
  await ui.approve.click();
  expect(await decision).toEqual({ decision: "granted" });
});

test("shift+y approves the host for the session until revoked", async ({ page, hitl, ui }) => {
  await ui.open();
  const first = await hitl.submitNetwork("registry.npmjs.org", 443);
  await ui.armed(first.id);
  await page.keyboard.press("Shift+Y");
  expect(await first.decision).toEqual({ decision: "granted" });

  const again = await hitl.submitNetwork("registry.npmjs.org", 443);
  expect(await again.decision).toEqual({ decision: "granted" });
  const otherPort = await hitl.submitNetwork("registry.npmjs.org", 80);
  expect(await hitl.pendingIDs()).toEqual([otherPort.id]);

  await page.keyboard.press("s");
  await expect(ui.grants).toHaveCount(1);
  await expect(ui.grants.first()).toContainText("net registry.npmjs.org:443");
  await expect(ui.grants.first()).toContainText("used once");
  await page.keyboard.press("x");
  await expect(ui.grants).toHaveCount(0);
});

test("shift+d denies the host for the session", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submitNetwork("telemetry.example.com", 443);
  await ui.shown(id);
  await page.keyboard.press("Shift+D");
  expect(await decision).toEqual({
    decision: "deny_session",
    reason: "Denied for session in browser",
  });

  await page.keyboard.press("h");
  await ui.history.first().click();
  await expect(ui.outcome).toContainText("Denied for the rest of this nono session.");
});

test("a request without a nono session is decided once", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submitNetwork("example.com", 443, { sessionID: "" });
  await ui.armed(id);
  await expect(ui.approveSession).toHaveCount(0);
  await expect(ui.denySession).toHaveCount(0);
  await page.keyboard.press("Shift+Y");
  await expect(ui.toast).toHaveText("No nono session to approve for.");
  await page.keyboard.press("n");
  expect(await decision).toEqual({ decision: "denied", reason: "Denied in browser" });
});

test("a loopback host is flagged and its denial stays in History", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submitNetwork("::1", 5432);
  await ui.shown(id);
  await expect(ui.destination.first()).toHaveText("[::1]:5432");
  await expect(ui.hostWarning).toContainText("This address is this machine.");
  await ui.denyWithNote.click();
  await ui.note.fill("no local databases");
  await page.keyboard.press("Enter");
  expect(await decision).toEqual({
    decision: "denied",
    reason: "Denied in browser: no local databases",
  });

  await page.keyboard.press("h");
  await expect(ui.history.first()).toContainText("net [::1]:5432");
  await ui.history.first().click();
  await expect(ui.hostWarning).toBeVisible();
});

test("a connection to the service's own port is denied without a card", async ({
  page,
  hitl,
  server,
  ui,
}) => {
  await ui.open();
  const port = Number(new URL(server.url).port);
  const { decision } = await hitl.submitNetwork("localtest.me", port);
  expect((await decision).decision).toBe("denied");
  expect(await hitl.pendingIDs()).toEqual([]);

  await page.keyboard.press("h");
  await ui.history.first().click();
  await expect(ui.outcome).toContainText("No human saw this request.");
});
