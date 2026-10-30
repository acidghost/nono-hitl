import { dockerAsk, expect, test } from "./fixtures";

const pushAsk = "Does this git push rewrite published history?";

test("an added classifier advises the next request and survives a reload", async ({
  page,
  hitl,
  ui,
}) => {
  await ui.open();
  await page.keyboard.press("c");
  await expect(ui.classifier(1).getByLabel("Ask")).toHaveValue(dockerAsk);
  await ui.addClassifier.click();
  const added = ui.classifier(2);
  await expect(added.getByLabel("Model")).toHaveValue("d3");
  await added.getByLabel("Prefix").fill("git push");
  await added.getByLabel("Ask").fill(pushAsk);
  await ui.saveConfig.click();
  await expect(ui.toast).toHaveText("Config saved.");

  await page.keyboard.press("p");
  const { id } = await hitl.submit(["git", "push", "origin", "main"]);
  await ui.shown(id);
  await expect(ui.advice).toContainText(`Asked d3: ${pushAsk}`);

  await page.goto("/#config");
  await expect(ui.classifier(2).getByLabel("Prefix")).toHaveValue("git push");
});

test("a removed classifier no longer advises", async ({ page, hitl, ui }) => {
  await ui.open();
  await page.keyboard.press("c");
  await ui.classifier(1).getByRole("button", { name: "Remove" }).click();
  await expect(ui.configStatus).toHaveText("Unsaved changes");
  await ui.saveConfig.click();
  await expect(ui.toast).toHaveText("Config saved.");

  await page.keyboard.press("p");
  const { id } = await hitl.submit(["docker", "ps"]);
  await ui.shown(id);
  await expect(ui.advice).toHaveCount(0);
});

test("the server's objection shows next to Save and nothing is saved", async ({ page, ui }) => {
  await ui.open();
  await page.keyboard.press("c");
  await ui.addClassifier.click();
  await ui.classifier(2).getByLabel("Prefix").fill("docker");
  await ui.classifier(2).getByLabel("Ask").fill(dockerAsk);
  await ui.saveConfig.click();
  await expect(ui.configStatus).toHaveText(
    'Classifier 2: prefix ["docker"] repeats an earlier entry',
  );

  await page.reload();
  await expect(ui.classifier(1)).toBeVisible();
  await expect(ui.classifier(2)).toHaveCount(0);
});
