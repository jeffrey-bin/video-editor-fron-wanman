import { stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAssetToProject, applyPendingPlan, createExportJob, createPromptEditJob, getJob, getProject, listAssets, resetInMemoryStateForTests } from "@/server/state/in-memory";

describe("in-memory P0 orchestration", () => {
  beforeEach(() => {
    resetInMemoryStateForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("imports media, generates a plan, applies it and exports", async () => {
    const project = getProject("project_demo");
    const initialVersion = project.timeline.version;
    const asset = await addAssetToProject(project.id, { name: "demo.mp4", type: "video/mp4", bytes: Buffer.from("not-real-video") });
    expect(asset.kind).toBe("video");
    expect(asset.filePath).toContain(".promptcut-runtime");
    expect(listAssets(project.id).some((item) => item.id === asset.id)).toBe(true);

    const promptJob = await createPromptEditJob({
      project_id: project.id,
      timeline_version: initialVersion + 1,
      prompt: "剪掉开头 3 秒，增强人声，让画面更明亮，添加字幕",
      locale: "zh-CN",
    });
    const job = getJob(promptJob.job_id);
    expect(job?.status).toBe("succeeded");
    const output = job?.output as { request_id: string; plan_state: string };
    expect(output.plan_state).toBe("ready");

    await expect(createExportJob({ project_id: project.id, preset: "1080p_landscape" })).rejects.toThrow("UNCONFIRMED_EDIT_PLAN");
    const applied = applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: initialVersion + 1 });
    expect(applied.applied_operation_ids.length).toBeGreaterThan(0);
    const exportJob = await createExportJob({ project_id: project.id, preset: "1080p_landscape" });
    const exportRecord = getJob(exportJob.job_id);
    expect(exportRecord?.status).toBe("succeeded");
    const exportOutput = exportRecord?.output as { export_path: string; file_size_bytes: number; mode: string };
    expect(exportOutput.file_size_bytes).toBeGreaterThan(0);
    expect((await stat(exportOutput.export_path)).size).toBeGreaterThan(0);
    expect(JSON.stringify(exportRecord?.output)).toContain("renderPlan");
  });

  it("rejects empty or invalid operation_ids without changing the timeline", async () => {
    const project = getProject("project_demo");
    await addAssetToProject(project.id, { name: "demo.mp4", type: "video/mp4", bytes: Buffer.from("media") });
    const version = project.timeline.version;
    const promptJob = await createPromptEditJob({
      project_id: project.id,
      timeline_version: version,
      prompt: "剪掉开头 3 秒并添加字幕",
      locale: "zh-CN",
    });
    const before = structuredClone(project.timeline);
    expect(() => applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: version, operation_ids: [] })).toThrow("operation_ids 不能为空");
    expect(project.timeline).toEqual(before);
    expect(() => applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: version, operation_ids: ["missing"] })).toThrow("operation_ids 不存在");
    expect(project.timeline).toEqual(before);
  });

  it("maps codex-cli provider failures to a failed prompt edit job", async () => {
    vi.stubEnv("LLM_PROVIDER", "codex-cli");
    vi.stubEnv("CODEX_CLI_BIN", process.execPath);
    vi.stubEnv("CODEX_CLI_MODEL", "gpt-test");
    vi.stubEnv("CODEX_CLI_TIMEOUT_MS", "1000");

    const project = getProject("project_demo");
    const promptJob = await createPromptEditJob({
      project_id: project.id,
      timeline_version: project.timeline.version,
      prompt: "生成一个待确认剪辑方案",
      locale: "zh-CN",
    });

    const job = getJob(promptJob.job_id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.code).toBe("LLM_PROCESS_FAILED");
  });

  it("records invalid plans, stale plans and failed exports without mutating state", async () => {
    const project = getProject("project_demo");
    const missingMediaExport = await createExportJob({ project_id: project.id, preset: "1080p_landscape", ignorePendingPlan: true });
    expect(getJob(missingMediaExport.job_id)?.status).toBe("failed");
    expect(getJob(missingMediaExport.job_id)?.error?.code).toBe("EXPORT_FAILED");

    await addAssetToProject(project.id, { name: "demo.mp4", type: "video/mp4", bytes: new Uint8Array() });
    vi.stubEnv("LLM_PROVIDER", "unsupported");
    const failedProviderJob = await createPromptEditJob({ project_id: project.id, timeline_version: project.timeline.version, prompt: "生成方案", locale: "zh-CN" });
    expect(getJob(failedProviderJob.job_id)?.error?.code).toBe("LLM_PROVIDER_UNSUPPORTED");
    vi.unstubAllEnvs();

    const staleVersion = project.timeline.version - 1;
    const staleJob = await createPromptEditJob({ project_id: project.id, timeline_version: staleVersion, prompt: "生成方案", locale: "zh-CN" });
    expect((getJob(staleJob.job_id)?.output as { plan_state: string }).plan_state).toBe("stale");
    expect(() => applyPendingPlan(project.id, { request_id: staleJob.request_id, timeline_version: staleVersion })).toThrow("方案当前不可应用");
  });
});
