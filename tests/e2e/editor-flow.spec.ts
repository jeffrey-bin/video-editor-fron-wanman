import { expect, test } from "@playwright/test";

test("P0 flow: import asset, prompt plan, apply, export", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("[data-testid=file-input]", {
    name: "travel-vlog.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("fake video"),
  });
  await expect(page.getByText("travel-vlog.mp4")).toBeVisible();
  await page.getByTestId("run-prompt").click();
  await expect(page.getByTestId("edit-plan")).toContainText("方案审阅");
  await page.getByTestId("apply-plan").click();
  await expect(page.getByText("版本 3")).toBeVisible();
  await page.getByRole("button", { name: /导出/ }).click();
  await expect(page.getByTestId("export-card")).toContainText("已完成");
});
