import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("P0 flow: import asset, prompt plan, apply, export", async ({ page }) => {
  await page.goto("/");
  const fixture = await readFile(join(process.cwd(), "tests/fixtures/minimal-real.mp4"));
  await page.setInputFiles("[data-testid=file-input]", {
    name: "travel-vlog.mp4",
    mimeType: "video/mp4",
    buffer: fixture,
  });
  await expect(page.getByText("travel-vlog.mp4")).toBeVisible();
  await page.getByTestId("run-prompt").click();
  await expect(page.getByTestId("edit-plan")).toContainText("方案审阅");
  await page.getByTestId("apply-plan").click();
  await expect(page.getByText("版本 3")).toBeVisible();
  await page.getByRole("button", { name: /导出/ }).click();
  await expect(page.getByTestId("export-card")).toContainText("已完成");
  await expect(page.getByTestId("export-card")).not.toContainText("local-dev-mp4");
});
