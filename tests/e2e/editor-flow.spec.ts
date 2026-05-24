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
  const exportResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/exports") && response.request().method() === "POST");
  await page.getByRole("button", { name: /导出/ }).click();
  const exportResponse = await exportResponsePromise;
  expect(exportResponse.ok()).toBe(true);
  const exportPayload = (await exportResponse.json()) as { job_id: string };
  expect(exportPayload.job_id).toMatch(/^export_/);

  await expect(page.getByTestId("export-card")).toContainText("已完成");
  await expect(page.getByTestId("export-card")).not.toContainText("local-dev-mp4");

  const jobPayload = await page.evaluate(async (jobId) => {
    const response = await fetch(`/api/jobs/${jobId}`);
    return response.json();
  }, exportPayload.job_id) as {
    job: {
      status: string;
      output: {
        export_path: string;
        file_size_bytes: number;
        mode: string;
        command: { bin: string; ffprobeBin: string };
      };
    };
  };
  expect(jobPayload.job.status).toBe("succeeded");
  expect(jobPayload.job.output.mode).toBe("ffmpeg");
  expect(jobPayload.job.output.file_size_bytes).toBeGreaterThan(0);
  expect(jobPayload.job.output.export_path).toMatch(/\.mp4$/);
  expect(jobPayload.job.output.command.bin).toContain("fake-ffmpeg.mjs");
  expect(jobPayload.job.output.command.ffprobeBin).toContain("fake-ffprobe.mjs");

  const exported = await readFile(jobPayload.job.output.export_path);
  expect(exported.length).toBe(jobPayload.job.output.file_size_bytes);
  expect(exported.subarray(4, 8).toString("utf8")).toBe("ftyp");
  expect(exported.includes("promptcut-local-dev-mp4")).toBe(false);
});
