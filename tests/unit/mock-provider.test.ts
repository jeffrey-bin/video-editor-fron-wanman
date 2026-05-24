import { describe, expect, it } from "vitest";
import { generateMockEditPlan } from "@/server/llm/mock-provider";
import type { LlmEditRequest } from "@/server/llm/edit-plan-protocol";

const baseRequest = (prompt: string, clips = [{ id: "clip", trackId: "video_main", kind: "video" as const, startMs: 0, endMs: 10000, assetId: "asset" }]): LlmEditRequest => ({
  request_id: "550e8400-e29b-41d4-a716-446655440000",
  project: { project_id: "project", duration_ms: 10000, timeline_version: 1 },
  user_intent: { prompt, locale: "zh-CN", scope: { type: "timeline", start_ms: 0, end_ms: 10000 } },
  context: {
    assets: [],
    clips,
    subtitles: [],
    available_operations: ["delete_range", "adjust_video", "adjust_audio", "add_subtitle"],
  },
  constraints: { max_operations: 50, require_user_confirmation: true, do_not_modify_source_files: true },
});

describe("mock provider", () => {
  it("turns prompt intents into deterministic P0 operations", async () => {
    const plan = await generateMockEditPlan(baseRequest("剪掉开头 3 秒空白，增强人声，让画面更明亮，添加字幕"));
    expect(plan.status).toBe("succeeded");
    expect(plan.operations.map((operation) => operation.type)).toEqual(["delete_range", "adjust_video", "adjust_audio", "add_subtitle"]);
  });

  it("returns capability boundary for unsupported generative intent", async () => {
    const plan = await generateMockEditPlan(baseRequest("把人物换成卡通形象"));
    expect(plan.unsupported_intents[0]?.reason).toContain("P0");
    expect(plan.operations[0]?.type).toBe("add_subtitle");
  });

  it("fails safely without editable media", async () => {
    const plan = await generateMockEditPlan(baseRequest("剪掉开头", []));
    expect(plan.status).toBe("failed");
    expect(plan.error?.code).toBe("NO_MEDIA");
  });
});
