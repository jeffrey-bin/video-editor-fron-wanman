import { describe, expect, it } from "vitest";
import { generateMockEditPlan } from "@/server/llm/mock-provider";
import { buildPromptQualityRequest, PROMPT_EDIT_QUALITY_CASES } from "@/server/llm/prompt-edit-quality-corpus";

const requestFor = (caseId: string) => buildPromptQualityRequest(PROMPT_EDIT_QUALITY_CASES.find((item) => item.case_id === caseId)!);

describe("mock provider P4 audio behavior", () => {
  it("generates reviewable noise, ducking and fade operations", async () => {
    const plan = await generateMockEditPlan(requestFor("audio_reduce_eq_duck_fade"));
    expect(plan.status).toBe("succeeded");
    expect(plan.requires_confirmation).toBe(true);
    expect(plan.operations.map((operation) => operation.type)).toEqual(expect.arrayContaining(["reduce_noise", "equalize_loudness", "duck_music", "apply_audio_fade"]));
  });

  it("returns partial for unknown track roles and unsupported voice cloning", async () => {
    await expect(generateMockEditPlan(requestFor("audio_unknown_roles_duck"))).resolves.toMatchObject({ status: "partial", operations: [], warnings: [{ code: "TRACK_ROLE_UNKNOWN" }] });
    const clone = await generateMockEditPlan(requestFor("audio_voice_clone_reject"));
    expect(clone.status).toBe("partial");
    expect(clone.unsupported_intents[0].reason).toContain("不支持声音克隆");
  });

  it("marks mock transcript subtitles with source and confirmation warnings", async () => {
    const plan = await generateMockEditPlan(requestFor("audio_subtitle_transcript"));
    expect(plan.operations[0]).toMatchObject({ type: "add_subtitle", params: { source: "mock_transcript", confidence: 0.98 } });
    expect(plan.warnings.map((warning) => warning.code)).toContain("MOCK_TRANSCRIPT_SOURCE");
  });
});
