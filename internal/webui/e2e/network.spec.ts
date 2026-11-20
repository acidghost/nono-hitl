import { expect, test } from "./fixtures";

test("a network request is approved once", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submitNetwork("registry.npmjs.org", 443);
  await ui.armed(id);
  await expect(ui.kind).toHaveText("net");
  await expect(ui.destination.first()).toHaveText("registry.npmjs.org:443");
  await expect(ui.hostWarning).toHaveCount(0);
  await expect(ui.approveSession).toHaveCount(0);
  await page.keyboard.press("Shift+Y");
  await expect(ui.toast).toHaveText("Network requests are approved once.");
  await ui.approve.click();
  expect(await decision).toEqual({ decision: "granted" });
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
