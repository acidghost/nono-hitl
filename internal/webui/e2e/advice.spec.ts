import { type Decision, dockerAsk, expect, test } from "./fixtures";

const deniedInBrowser: Decision = { decision: "denied", reason: "Denied in browser" };

test("a risky answer shows on the card and stays in History", async ({ page, hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submit(["docker", "run", "--rm", "-v", "/:/host", "alpine"]);
  await ui.shown(id);
  await expect(ui.advice).toContainText("Looks risky");
  await expect(ui.advice).toContainText("0.910 > 0.300");
  await expect(ui.advice).toContainText(`Asked d3: ${dockerAsk}`);
  await page.keyboard.press("n");
  expect(await decision).toEqual(deniedInBrowser);

  await page.keyboard.press("h");
  await ui.history.first().click();
  await expect(ui.advice).toContainText("Looks risky");
});

test("a safe answer shows on the card", async ({ hitl, ui }) => {
  await ui.open();
  const { id } = await hitl.submit(["docker", "ps"]);
  await ui.shown(id);
  await expect(ui.advice).toContainText("Looks safe");
  await expect(ui.advice).toContainText("0.020 ≤ 0.300");
});

test("a failed call says why and leaves the decision to the human", async ({ hitl, ui }) => {
  await ui.open();
  const { id, decision } = await hitl.submit(["docker", "pull", "alpine"]);
  await expect(ui.advice).toContainText("Unavailable");
  await expect(ui.advice).toContainText("HTTP 404: model 'd3' not found");
  await ui.armed(id);
  await ui.approve.click();
  expect(await decision).toEqual({ decision: "granted" });
});

test("the badge says classifying until the model answers", async ({ hitl, ui }) => {
  await ui.open();
  const { id } = await hitl.submit(["docker", "build", "."]);
  await ui.shown(id);
  await expect(ui.advice).toContainText("Classifying…");
});

test("a request no classifier matches has no advice", async ({ hitl, ui }) => {
  await ui.open();
  const { id } = await hitl.submit(["git", "push"]);
  await ui.shown(id);
  await expect(ui.advice).toHaveCount(0);
});
