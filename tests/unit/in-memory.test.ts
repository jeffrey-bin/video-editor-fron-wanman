import { describe, expect, it } from "vitest";
import { addAssetToProject, applyPendingPlan, createExportJob, createPromptEditJob, getJob, getProject, listAssets } from "@/server/state/in-memory";

describe("in-memory P0 orchestration", () => {
  it("imports media, generates a plan, applies it and exports", async () => {
    const project = getProject("project_demo");
    const initialVersion = project.timeline.version;
    const asset = addAssetToProject(project.id, { name: "demo.mp4", type: "video/mp4" });
    expect(asset.kind).toBe("video");
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

    expect(() => createExportJob({ project_id: project.id, preset: "1080p_landscape" })).toThrow("UNCONFIRMED_EDIT_PLAN");
    const applied = applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: initialVersion + 1 });
    expect(applied.applied_operation_ids.length).toBeGreaterThan(0);
    const exportJob = createExportJob({ project_id: project.id, preset: "1080p_landscape" });
    const exportRecord = getJob(exportJob.job_id);
    expect(exportRecord?.status).toBe("succeeded");
    expect(JSON.stringify(exportRecord?.output)).toContain("ffmpeg");
  });
});
