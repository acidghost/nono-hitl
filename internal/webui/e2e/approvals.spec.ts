import { type Decision, expect, test } from "./fixtures";

const granted: Decision = { decision: "granted" };
const deniedInBrowser: Decision = { decision: "denied", reason: "Denied in browser" };

test("a click after arming approves once", async ({ hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submit(["gh", "pr", "create", "--fill"]);
  await ui.armed(id);
  await ui.approve.click();
  expect(await decision).toEqual(granted);
});

test("a click while arming decides nothing", async ({ page, hitl, ui }) => {
  await ui.open();
  const { decision } = await hitl.submit(["gh", "pr", "merge"]);
  await ui.approve.click();
  await expect(ui.toast).toHaveText("Not armed yet. Wait for the bar to fill.");
  await page.keyboard.press("n");
  expect(await decision).toEqual(deniedInBrowser);
});

test("y after a pause approves once", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submit(["git", "push"]);
  await ui.armed(id);
  await page.keyboard.press("y");
  expect(await decision).toEqual(granted);
});

test("y right after another key is ignored", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submit(["git", "push"]);
  await ui.armed(id);
  await page.keyboard.press("a");
  await page.keyboard.press("y");
  await expect(ui.toast).toHaveText("Typing detected. Shortcut ignored.");
  await page.keyboard.press("n");
  expect(await decision).toEqual(deniedInBrowser);
});

test("a key right after y cancels the approval", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submit(["git", "push"]);
  await ui.armed(id);
  await page.keyboard.press("y");
  await page.keyboard.press("a");
  await expect(ui.toast).toHaveText("Typing detected. Shortcut ignored.");
  // Past the quiet window, when a queued approval would have gone out.
  await page.waitForTimeout(500);
  expect(await hitl.pendingIDs()).toEqual([id]);
  await page.keyboard.press("n");
  expect(await decision).toEqual(deniedInBrowser);
});

test("n denies", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submit(["rm", "-rf", "build"]);
  await ui.shown(id);
  await page.keyboard.press("n");
  expect(await decision).toEqual(deniedInBrowser);
});

test("shift+y approves the same argv until revoked", async ({ page, hitl, ui }) => {
  const argv = ["gh", "pr", "view", "42"];
  await ui.open();
  const first = await hitl.submit(argv);
  await ui.armed(first.id);
  await page.keyboard.press("Shift+Y");
  expect(await first.decision).toEqual(granted);

  const repeat = await hitl.submit(argv);
  expect(await repeat.decision).toEqual(granted);

  await page.keyboard.press("s");
  await expect(ui.grants).toHaveCount(1);
  await page.keyboard.press("x");
  await expect(ui.grants).toHaveCount(0);

  const afterRevoke = await hitl.submit(argv);
  await page.keyboard.press("p");
  await ui.shown(afterRevoke.id);
  await page.keyboard.press("n");
  expect(await afterRevoke.decision).toEqual(deniedInBrowser);
});

test("typing in the filter triggers no shortcut", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submit(["git", "push"]);
  await ui.armed(id);
  await page.keyboard.press("h");
  await ui.filter.click();
  // Slower than the quiet window, so only the focus check can stop these.
  await ui.filter.pressSequentially("psh?xyY", { delay: 400 });
  await expect(ui.filter).toHaveValue("psh?xyY");
  await expect(page).toHaveURL(/#history$/);
  await expect(ui.help).toBeHidden();
  expect(await hitl.pendingIDs()).toEqual([id]);

  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await ui.shown(id);
  await page.keyboard.press("n");
  expect(await decision).toEqual(deniedInBrowser);
});

test("decisions are disabled while the event stream is down", async ({ page, hitl, ui }) => {
  await page.route("**/api/v1/events", (route) => route.abort());
  const { id, decision } = await hitl.submit(["curl", "https://example.com"]);
  await page.goto("/");
  await expect(ui.offline).toContainText("Connection lost.");
  await expect(ui.queue).toHaveCount(1);
  await expect(ui.approve).toBeDisabled();
  await expect(ui.approveSession).toBeDisabled();
  await expect(ui.deny).toBeDisabled();
  await page.keyboard.press("n");
  expect(await hitl.pendingIDs()).toEqual([id]);

  await hitl.decide(id, "denied", "Denied by the e2e suite");
  expect(await decision).toEqual({ decision: "denied", reason: "Denied by the e2e suite" });
});

test("hostile request fields render as text", async ({ page, hitl, ui }) => {
  // The server caps one argument at 8 KiB.
  const long = "x".repeat(8000);
  await ui.open();
  const { id, decision } = await hitl.submit(
    ["sh", "<img src=x onerror=alert(1)>", "bell\u0007 escape\u001b[31m newline\n", long],
    { reason: "<b>trust me</b>" },
  );
  await ui.shown(id);
  await expect(ui.chips).toHaveText([
    "sh",
    '"<img src=x onerror=alert(1)>"',
    '"bell\\u0007 escape\\u001b[31m newline\\n"',
    `${"x".repeat(120)}…`,
  ]);
  await expect(page.locator(".exception-reason")).toHaveText("<b>trust me</b>");
  await expect(page.locator("main img, main b")).toHaveCount(0);

  await page.getByRole("button", { name: "+7880 chars" }).click();
  await expect(ui.chips.last()).toHaveText(long);
  await page.keyboard.press("n");
  expect(await decision).toEqual(deniedInBrowser);
});
