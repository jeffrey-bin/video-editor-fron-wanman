import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dryRunEditPlan } from "@/server/editor/timeline-ops";
import { generateCodexCliEditPlan } from "@/server/llm/codex-cli-provider";
import { EditPlanResponseSchema } from "@/server/llm/edit-plan-protocol";
import { generateMockEditPlan } from "@/server/llm/mock-provider";
import { buildPromptQualityRequest, PROMPT_EDIT_QUALITY_CASES, promptQualityTimeline } from "@/server/llm/prompt-edit-quality-corpus";
import { evaluatePromptQualityProvider, normalizePlan } from "@/server/llm/prompt-edit-quality-eval";

describe("Prompt 编辑质量评测 harness", () => {
  it("loads the P3+P4 benchmark corpus with required category coverage", () => {
    expect(PROMPT_EDIT_QUALITY_CASES.length).toBeGreaterThanOrEqual(88);
    expect(new Set(PROMPT_EDIT_QUALITY_CASES.map((qualityCase) => qualityCase.category))).toEqual(
      new Set(["single_cut", "polish", "subtitle", "multi_step", "conflict", "capability_boundary", "timeline_safety", "provider_consistency", "audio"]),
    );
  });

  it("validates mock provider plans through schema, operation whitelist and timeline dry-run", async () => {
    const result = await evaluatePromptQualityProvider("mock", generateMockEditPlan);
    expect(result.total_cases).toBe(PROMPT_EDIT_QUALITY_CASES.length);
    expect(result.failures).toEqual([]);
    expect(result.hard_failures).toBe(0);
    expect(result.average_score).toBeGreaterThanOrEqual(85);
    expect(Object.values(result.category_scores).every((score) => score >= 80)).toBe(true);
  });

  it("enforces structured edit-plan safety assertions on representative cases", async () => {
    const introCase = PROMPT_EDIT_QUALITY_CASES.find((qualityCase) => qualityCase.case_id === "cut_intro_005");
    const unsupportedCase = PROMPT_EDIT_QUALITY_CASES.find((qualityCase) => qualityCase.case_id === "unsupported_cartoon_001");
    expect(introCase).toBeDefined();
    expect(unsupportedCase).toBeDefined();

    const introRequest = buildPromptQualityRequest(introCase!);
    const introPlan = EditPlanResponseSchema.parse(await generateMockEditPlan(introRequest));
    expect(introPlan.operations[0]).toMatchObject({ type: "delete_range", target: { start_ms: 0, end_ms: 5000 }, params: { ripple: true } });
    expect(dryRunEditPlan(promptQualityTimeline(), introPlan.operations).timeline.durationMs).toBe(55000);

    const unsupportedPlan = EditPlanResponseSchema.parse(await generateMockEditPlan(buildPromptQualityRequest(unsupportedCase!)));
    expect(unsupportedPlan.status).toBe("partial");
    expect(unsupportedPlan.operations).toHaveLength(0);
    expect(unsupportedPlan.unsupported_intents[0]?.reason).toContain("不能换脸");
  });

  it("checks mock and Codex CLI provider normalized consistency through the spawn/stdio/schema path", async () => {
    const cases = PROMPT_EDIT_QUALITY_CASES.filter((qualityCase) => qualityCase.category === "provider_consistency");
    vi.stubEnv("CODEX_CLI_BIN", join(process.cwd(), "tests/fixtures/fake-codex-cli.mjs"));
    for (const qualityCase of cases) {
      const request = buildPromptQualityRequest(qualityCase);
      const mockPlan = await generateMockEditPlan(request);
      const codexPlan = await generateCodexCliEditPlan(request, {
        cwd: process.cwd(),
        timeoutMs: 2000,
        env: { PATH: process.env.PATH },
      });
      expect(normalizePlan(codexPlan)).toEqual(normalizePlan(mockPlan));
      expect(codexPlan.request_id).toBe(request.request_id);
    }
  });
});
