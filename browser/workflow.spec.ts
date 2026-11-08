import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
test("sample setup, proof failure, accepted candidate, live comparison, and downloads", async ({
  page,
}) => {
  await page.goto("/");
  const token = (
    await readFile(resolve(".data/browser/access-token"), "utf8")
  ).trim();
  await page.getByLabel("Workspace access code").fill(token);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect the software" }),
  ).toBeVisible();
  await page
    .getByLabel("Execution profile")
    .selectOption({ label: "Custom toothbrush · example only" });
  await expect(
    page.getByText(
      "No execution adapter exists for this target. Hardware files do not create a simulator.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start protection run" }),
  ).toBeDisabled();
  await page
    .getByLabel("Execution profile")
    .selectOption({ label: "This computer · trusted development" });
  await page.getByLabel("Candidate attempts").fill("1");
  await page.getByRole("button", { name: "Start protection run" }).click();
  await expect(
    page.getByRole("heading", { name: "Verified. Packaged. Ready." }),
  ).toBeVisible({ timeout: 90000 });
  await page.getByRole("button", { name: "Incorrect control" }).click();
  await page.getByRole("tab", { name: "Formal evidence" }).click();
  await expect(
    page.getByText("VERIFICATION FAILED", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "encoded" }).click();
  await page.getByRole("tab", { name: "Formal evidence" }).click();
  await expect(
    page.getByText("VERIFICATION SUCCESSFUL", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Raw reading").fill("812");
  await page.getByLabel("Gain", { exact: true }).fill("300");
  await page.getByLabel("Offset", { exact: true }).fill("-21");
  await page.getByRole("button", { name: "Compare ↗", exact: true }).click();
  await expect(page.getByText("EXACT MATCH", { exact: true })).toBeVisible();
  await expect(page.getByText("931", { exact: true })).toHaveCount(2);
  for (const name of ["Source archive", "Executable package"]) {
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: new RegExp(name) }).click();
    const download = await downloading;
    await download.saveAs(
      resolve(".data/browser", download.suggestedFilename()),
    );
    expect(await download.failure()).toBeNull();
  }
  await page.getByRole("tab", { name: "Reconstruction", exact: true }).click();
  await expect(page.getByText("RECOVERED", { exact: true })).toHaveCount(3);
  await page.screenshot({
    path: ".data/browser/workflow-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".data/browser/workflow-mobile.png",
    fullPage: true,
  });
});
test("an active run can be cancelled and remains cancelled after reload", async ({
  page,
}) => {
  await page.goto("/");
  const token = (
    await readFile(resolve(".data/browser/access-token"), "utf8")
  ).trim();
  await page.getByLabel("Workspace access code").fill(token);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByLabel("Candidate attempts").fill("12");
  await page.getByRole("button", { name: "Start protection run" }).click();
  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Run cancelled." }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /Run history/ }).click();
  await expect(
    page.getByText("cancelled", { exact: true }).first(),
  ).toBeVisible();
});
