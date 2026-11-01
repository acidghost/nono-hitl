import { dockerClassifier, expect, test } from "./fixtures";

const hostChroot = ["docker", "run", "--rm", "-v", "/:/host", "alpine", "chroot", "/host"];

test("deny decides without a human, and History says so", async ({ page, hitl, ui }) => {
  await hitl.configure([dockerClassifier("deny")]);
  await ui.open();
  const safe = await hitl.submit(["docker", "ps"]);
  expect(await safe.decision).toEqual({ decision: "granted" });
  const risky = await hitl.submit(hostChroot);
  expect(await risky.decision).toEqual({
    decision: "denied",
    reason: "Denied by the command classifier.",
  });
  expect(await hitl.pendingIDs()).toEqual([]);

  await page.keyboard.press("h");
  await ui.history.first().click();
  await expect(ui.outcome).toContainText("No human saw this request.");
  await expect(ui.outcome).toContainText("Denied by the command classifier.");
  await expect(ui.advice).toContainText("Looks risky");
});

test("forward hands a risky request to the human with its advice", async ({ hitl, ui }) => {
  await hitl.configure([dockerClassifier("forward")]);
  await ui.open();
  const { id, decision } = await hitl.submit(hostChroot);
  await ui.shown(id);
  await expect(ui.advice).toContainText("Looks risky");
  await ui.deny.click();
  expect(await decision).toEqual({ decision: "denied", reason: "Denied in browser" });
});
