import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildRealLlmSemanticRequest, EXPECTED_REAL_LLM_SEMANTIC_PLANS, REAL_LLM_SEMANTIC_CASES } from "@/server/llm/real-llm-semantic-cases";
import { ExpectedRealLlmSemanticPlanSchema, RealLlmSemanticCaseSchema } from "@/server/llm/real-llm-semantic-schema";
import { validateRealLlmSemanticFixtures } from "@/server/llm/real-llm-semantic-eval";

describe("real LLM semantic fixture schemas", () => {
  it("loads exactly the 24 product-specified Chinese cases and expected plans", async () => {
    expect(validateRealLlmSemanticFixtures()).toBe(true);
    expect(REAL_LLM_SEMANTIC_CASES).toHaveLength(24);
    expect(EXPECTED_REAL_LLM_SEMANTIC_PLANS).toHaveLength(24);
    expect(REAL_LLM_SEMANTIC_CASES.map((item) => item.case_id)).toEqual([
      "llm_semantic_cut_001",
      "llm_semantic_cut_002",
      "llm_semantic_cut_003",
      "llm_semantic_cut_004",
      "llm_semantic_cut_005",
      "llm_semantic_cut_006",
      "llm_semantic_subtitle_007",
      "llm_semantic_subtitle_008",
      "llm_semantic_subtitle_009",
      "llm_semantic_subtitle_010",
      "llm_semantic_audio_011",
      "llm_semantic_audio_012",
      "llm_semantic_audio_013",
      "llm_semantic_audio_014",
      "llm_semantic_audio_015",
      "llm_semantic_video_016",
      "llm_semantic_video_017",
      "llm_semantic_video_018",
      "llm_semantic_video_019",
      "llm_semantic_multi_020",
      "llm_semantic_multi_021",
      "llm_semantic_conflict_022",
      "llm_semantic_conflict_023",
      "llm_semantic_safety_024",
    ]);
    for (const item of REAL_LLM_SEMANTIC_CASES) expect(RealLlmSemanticCaseSchema.safeParse(item).success).toBe(true);
    for (const item of EXPECTED_REAL_LLM_SEMANTIC_PLANS) expect(ExpectedRealLlmSemanticPlanSchema.safeParse(item).success).toBe(true);
    const readableFixture = JSON.parse(await readFile("tests/fixtures/llm/real-llm-semantic-cases.zh.json", "utf8")) as Array<{ case_id: string }>;
    expect(readableFixture.map((item) => item.case_id)).toEqual(REAL_LLM_SEMANTIC_CASES.map((item) => item.case_id));
  });

  it("builds LlmEditRequest with source-file protection and fixture-only metadata", () => {
    const request = buildRealLlmSemanticRequest(REAL_LLM_SEMANTIC_CASES[0], "550e8400-e29b-41d4-a716-446655440000");
    expect(request.constraints.do_not_modify_source_files).toBe(true);
    expect(request.user_intent.locale).toBe("zh-CN");
    expect(request.context.available_operations).toContain("delete_range");
    expect(request.context.assets[0].originalName).toBe("fixture-media");
  });
});

