import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { dryRunEditPlan } from "@/server/editor/timeline-ops";
import { generateCodexCliEditPlan } from "@/server/llm/codex-cli-provider";
import { EditPlanResponseSchema } from "@/server/llm/edit-plan-protocol";
import { generateMockEditPlan } from "@/server/llm/mock-provider";
import { buildPromptQualityRequest, PROMPT_EDIT_QUALITY_CASES, promptQualityTimeline } from "@/server/llm/prompt-edit-quality-corpus";
import { evaluatePromptQualityProvider, normalizePlan } from "@/server/llm/prompt-edit-quality-eval";
import type { EditPlanResponse, LlmEditRequest } from "@/server/llm/edit-plan-protocol";

const successfulSpawn = (planForRequest: (request: LlmEditRequest) => Promise<EditPlanResponse>) => {
  return ((command: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"]; env: Record<string, string | undefined>; cwd: string }) => {
    void command;
    void args;
    void options;
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", null);
    };
    let promptInput = "";
    child.stdin.on("data", (chunk) => {
      promptInput += chunk.toString();
    });
    child.stdin.on("finish", () => {
      const first = promptInput.indexOf("{");
      const request = JSON.parse(promptInput.slice(first)) as LlmEditRequest;
      planForRequest(request)
        .then((plan) => {
          child.stdout.end(JSON.stringify(plan));
          child.stderr.end("");
          child.emit("close", 0);
        })
        .catch((error: unknown) => {
          child.stdout.end("");
          child.stderr.end(error instanceof Error ? error.message : String(error));
          child.emit("close", 1);
        });
    });
    return child;
  }) as never;
};

describe("Prompt 编辑质量评测 harness", () => {
  it("loads the 48-case P3 benchmark corpus with required category coverage", () => {
    expect(PROMPT_EDIT_QUALITY_CASES).toHaveLength(48);
    expect(new Set(PROMPT_EDIT_QUALITY_CASES.map((qualityCase) => qualityCase.category))).toEqual(
      new Set(["single_cut", "polish", "subtitle", "multi_step", "conflict", "capability_boundary", "timeline_safety", "provider_consistency"]),
    );
  });

  it("validates mock provider plans through schema, operation whitelist and timeline dry-run", async () => {
    const result = await evaluatePromptQualityProvider("mock", generateMockEditPlan);
    expect(result.total_cases).toBe(48);
    expect(result.hard_failures).toBe(0);
    expect(result.average_score).toBeGreaterThanOrEqual(85);
    expect(Object.values(result.category_scores).every((score) => score >= 80)).toBe(true);
    expect(result.failures).toEqual([]);
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

  it("checks mock and Codex CLI provider normalized consistency without invoking a real shell model", async () => {
    const cases = PROMPT_EDIT_QUALITY_CASES.filter((qualityCase) => qualityCase.category === "provider_consistency");
    for (const qualityCase of cases) {
      const request = buildPromptQualityRequest(qualityCase);
      const mockPlan = await generateMockEditPlan(request);
      const codexPlan = await generateCodexCliEditPlan(request, {
        cwd: "/tmp/promptcut-quality-codex",
        timeoutMs: 100,
        env: { PATH: "/bin" },
        spawnImpl: successfulSpawn(generateMockEditPlan),
      });
      expect(normalizePlan(codexPlan)).toEqual(normalizePlan(mockPlan));
      expect(codexPlan.request_id).toBe(request.request_id);
    }
  });
});
