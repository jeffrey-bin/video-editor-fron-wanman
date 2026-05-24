import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("P4 flow: audio prompt review, transcript panel, apply and export", async ({ page }) => {
  await page.goto("/");
  const fixture = await readFile(join(process.cwd(), "tests/fixtures/minimal-real.mp4"));
  await page.setInputFiles("[data-testid=file-input]", { name: "podcast-demo.mp4", mimeType: "video/mp4", buffer: fixture });
  await expect(page.getByText("podcast-demo.mp4")).toBeVisible();
  await expect(page.getByTestId("waveform-panel")).toBeVisible();
  await expect(page.getByTestId("transcript-panel")).toContainText("source=mock");
  await page.getByTestId("run-prompt").click();
  await expect(page.getByTestId("edit-plan")).toContainText("音频编辑方案");
  await expect(page.getByTestId("audio-operation-card").first()).toContainText("reduce_noise");
  await expect(page.getByTestId("edit-plan")).toContainText("duck_music");
  await expect(page.getByTestId("edit-plan")).toContainText("apply_audio_fade");
  const applyResponsePromise = page.waitForResponse((response) => response.url().includes("/apply-edit-plan") && response.request().method() === "POST");
  await page.getByTestId("apply-plan").click();
  const applyResponse = await applyResponsePromise;
  expect(applyResponse.ok()).toBe(true);
  await expect(page.getByText("timeline v3 · dry-run 通过")).toBeVisible();

  const exportResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/exports") && response.request().method() === "POST");
  await page.getByTestId("export-timeline").click();
  const exportResponse = await exportResponsePromise;
  expect(exportResponse.ok()).toBe(true);
  const exportPayload = (await exportResponse.json()) as { job_id: string };
  const jobPayload = await page.evaluate(async (jobId) => {
    const response = await fetch(`/api/jobs/${jobId}`);
    return response.json();
  }, exportPayload.job_id) as { job: { status: string; output: { command: { args: string[] } } } };
  expect(jobPayload.job.status).toBe("succeeded");
  expect(jobPayload.job.output.command.args.join(" ")).toContain("afftdn");
  expect(jobPayload.job.output.command.args.join(" ")).toContain("loudnorm");
});
