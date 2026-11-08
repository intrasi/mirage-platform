import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("local transformer executes live checks and exposes its runtime package", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Workspace access code")
    .fill(
      (await readFile(resolve(".data/browser/access-token"), "utf8")).trim(),
    );
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Small model. Changing code." }),
  ).toBeVisible();
  await expect(page.getByText("764,544", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Runtime performance" }),
  ).toBeVisible();
  await page.getByLabel("Generation seed").fill("100123");
  await page.getByRole("button", { name: "Run live runtime check" }).click();
  await expect(
    page.getByRole("button", { name: "Run live runtime check" }),
  ).toBeEnabled({ timeout: 30000 });
  await expect(
    page.getByText("EXECUTION BLOCKED", { exact: true }),
  ).toHaveCount(4);
  await expect(page.getByText("1,260", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download runtime package" }).click();
  expect((await download).suggestedFilename()).toBe(
    "mirage-neural-runtime.tar.gz",
  );
  await page.screenshot({
    path: ".data/browser/runtime-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Run live runtime check" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: ".data/browser/runtime-mobile.png",
    fullPage: true,
  });
});
