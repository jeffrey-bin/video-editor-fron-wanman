import { describe, expect, it } from "vitest";
import { EditPlanResponseSchema, LlmEditRequestSchema } from "@/server/llm/edit-plan-protocol";

const request = {
  request_id: "550e8400-e29b-41d4-a716-446655440000",
  project: { project_id: "project", duration_ms: 10000, timeline_version: 1 },
  user_intent: { prompt: "剪掉开头", locale: "zh-CN", scope: { type: "timeline", start_ms: 0, end_ms: 10000 } },
  context: { assets: [], clips: [], subtitles: [], available_operations: ["delete_range"] },
  constraints: { max_operations: 50, require_user_confirmation: true, do_not_modify_source_files: true },
};

describe("LLM edit-plan protocol", () => {
  it("validates request identity, scope, constraints and operation boundary", () => {
    expect(LlmEditRequestSchema.safeParse(request).success).toBe(true);
    expect(LlmEditRequestSchema.safeParse({ ...request, context: { ...request.context, available_operations: ["shell_exec"] } }).success).toBe(false);
  });

  it("requires failed plans to carry an error and no operations", () => {
    const failed = {
      request_id: request.request_id,
      status: "failed",
      summary: "失败",
      confidence: 0.4,
      requires_confirmation: true,
      warnings: [],
      operations: [],
      unsupported_intents: [],
      error: { code: "LLM_INVALID_JSON", message: "模型返回格式无效" },
    };
    expect(EditPlanResponseSchema.safeParse(failed).success).toBe(true);
    expect(EditPlanResponseSchema.safeParse({ ...failed, error: undefined }).success).toBe(false);
  });

  it("forces confirmation for low-confidence plans and explains partial plans", () => {
    const partial = {
      request_id: request.request_id,
      status: "partial",
      summary: "部分支持",
      confidence: 0.5,
      requires_confirmation: true,
      warnings: [],
      operations: [],
      unsupported_intents: [{ intent: "卡通化", reason: "P0 不支持" }],
    };
    expect(EditPlanResponseSchema.safeParse(partial).success).toBe(true);
    expect(EditPlanResponseSchema.safeParse({ ...partial, requires_confirmation: false }).success).toBe(false);
    expect(EditPlanResponseSchema.safeParse({ ...partial, unsupported_intents: [] }).success).toBe(false);
  });
});
