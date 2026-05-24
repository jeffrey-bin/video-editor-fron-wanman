import { describe, expect, it } from "vitest";
import { buildRealLlmSemanticRequest, REAL_LLM_SEMANTIC_CASES } from "@/server/llm/real-llm-semantic-cases";
import { evaluateRealLlmSemanticCase, generateRealLlmSemanticMockPlan, normalizeRealLlmPlan, runRealLlmSemanticQuality } from "@/server/llm/real-llm-semantic-eval";

describe("real LLM semantic evaluator", () => {
  it("passes all 24 Chinese cases with the deterministic mock provider", async () => {
    const report = await runRealLlmSemanticQuality({ provider: "mock", suite: "full", env: { PATH: "/bin" } });
    expect(report.summary.total_cases).toBe(24);
    expect(report.summary.passed_cases).toBe(24);
    expect(report.summary.hard_failures).toBe(0);
    expect(report.summary.average_score).toBeGreaterThanOrEqual(85);
    expect(report.summary.real_secret_usage_count).toBe(0);
    expect(report.cases).toHaveLength(24);
  });

  it("hard-fails instead of reading real LLM secrets", async () => {
    await expect(runRealLlmSemanticQuality({ provider: "mock", suite: "smoke", env: { PATH: "/bin", OPENAI_API_KEY: "sk-live-secret" } })).rejects.toThrow("REAL_LLM_SECRET_PRESENT");
  });

  it("maps source overwrite to failed with no operations", async () => {
    const safetyCase = REAL_LLM_SEMANTIC_CASES.find((item) => item.case_id === "llm_semantic_safety_024");
    expect(safetyCase).toBeDefined();
    const request = buildRealLlmSemanticRequest(safetyCase!);
    const plan = await generateRealLlmSemanticMockPlan(request, safetyCase!);
    expect(plan.status).toBe("failed");
    expect(plan.error?.code).toBe("SOURCE_FILE_PROTECTION");
    expect(plan.operations).toEqual([]);
  });

  it("does not fake object removal as a regular video adjustment", async () => {
    const objectRemovalCase = REAL_LLM_SEMANTIC_CASES.find((item) => item.case_id === "llm_semantic_video_019");
    expect(objectRemovalCase).toBeDefined();
    const result = await evaluateRealLlmSemanticCase(objectRemovalCase!, "mock", { env: { PATH: "/bin" } });
    expect(result.status).toBe("passed");
    expect(result.operation_types).not.toContain("adjust_video");
    expect(result.normalized_plan?.unsupported_intents).toContain("对象移除");
  });

  it("keeps voice gain scoped to voice clip instead of deleting video", async () => {
    const audioCase = REAL_LLM_SEMANTIC_CASES.find((item) => item.case_id === "llm_semantic_audio_011");
    expect(audioCase).toBeDefined();
    const request = buildRealLlmSemanticRequest(audioCase!);
    const plan = await generateRealLlmSemanticMockPlan(request, audioCase!);
    const normalized = normalizeRealLlmPlan(audioCase!.case_id, "mock", plan);
    expect(normalized.operation_types).toEqual(["adjust_audio"]);
    expect(normalized.operations[0].target).toEqual({ clip_id: "voice-1" });
  });
});

