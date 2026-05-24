import { describe, expect, it, vi } from "vitest";
import { generateConfiguredEditPlan, selectLlmProvider } from "@/server/llm/provider";
import type { EditPlanResponse, LlmEditRequest } from "@/server/llm/edit-plan-protocol";

const request: LlmEditRequest = {
  request_id: "550e8400-e29b-41d4-a716-446655440000",
  project: { project_id: "project", duration_ms: 10000, timeline_version: 1 },
  user_intent: { prompt: "生成方案", locale: "zh-CN", scope: { type: "timeline", start_ms: 0, end_ms: 10000 } },
  context: { assets: [], clips: [], subtitles: [], available_operations: ["add_subtitle"] },
  constraints: { max_operations: 50, require_user_confirmation: true, do_not_modify_source_files: true },
};

const plan: EditPlanResponse = {
  request_id: request.request_id,
  status: "succeeded",
  summary: "ok",
  confidence: 0.8,
  requires_confirmation: true,
  warnings: [],
  operations: [],
  unsupported_intents: [],
};

describe("llm provider selection", () => {
  it("defaults to mock and calls the mock provider", async () => {
    const mock = vi.fn(async () => plan);
    const codexCli = vi.fn(async () => plan);

    await expect(generateConfiguredEditPlan(request, { env: {}, providers: { mock, codexCli } })).resolves.toEqual(plan);
    expect(mock).toHaveBeenCalledWith(request);
    expect(codexCli).not.toHaveBeenCalled();
  });

  it("selects codex-cli and passes codex CLI options", async () => {
    const mock = vi.fn(async () => plan);
    const codexCli = vi.fn(async () => plan);
    const codexCliOptions = { bin: "local-codex", model: "gpt-test", timeoutMs: 1234 };

    await expect(
      generateConfiguredEditPlan(request, {
        env: { LLM_PROVIDER: "codex-cli" },
        codexCli: codexCliOptions,
        providers: { mock, codexCli },
      }),
    ).resolves.toEqual(plan);

    expect(codexCli).toHaveBeenCalledWith(request, codexCliOptions);
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects unsupported provider names", () => {
    expect(() => selectLlmProvider({ LLM_PROVIDER: "openai" })).toThrow("Unsupported LLM_PROVIDER");
  });
});
