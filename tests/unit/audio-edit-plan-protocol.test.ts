import { describe, expect, it } from "vitest";
import { EditOperationSchema } from "@/server/editor/operation-schema";
import { EditPlanResponseSchema, LlmEditRequestSchema, validateEditPlanAgainstRequest } from "@/server/llm/edit-plan-protocol";
import { buildPromptQualityRequest, PROMPT_EDIT_QUALITY_CASES } from "@/server/llm/prompt-edit-quality-corpus";

describe("P4 audio edit plan protocol", () => {
  it("accepts audio operations and enforces parameter ranges", () => {
    expect(EditOperationSchema.safeParse({ id: "rn", type: "reduce_noise", target: { track_id: "audio_main" }, params: { strength: 0.45, noise_profile: "auto", preserve_voice: true }, rationale: "降噪" }).success).toBe(true);
    expect(EditOperationSchema.safeParse({ id: "eq", type: "equalize_loudness", target: { track_id: "audio_main" }, params: { target_lufs: -16, max_gain_db: 6, limit_peak_dbfs: -1, scope_mode: "track" }, rationale: "响度" }).success).toBe(true);
    expect(EditOperationSchema.safeParse({ id: "bad", type: "equalize_loudness", target: {}, params: { target_lufs: -8, max_gain_db: 13, limit_peak_dbfs: 0, scope_mode: "track" }, rationale: "bad" }).success).toBe(false);
    expect(EditOperationSchema.safeParse({ id: "mute", type: "mute_range", target: { start_ms: 0, end_ms: 1000 }, params: { ramp_ms: 80, preserve_video: false }, rationale: "bad" }).success).toBe(false);
  });

  it("validates audio context and request-level available operations", () => {
    const request = buildPromptQualityRequest(PROMPT_EDIT_QUALITY_CASES.find((item) => item.case_id === "audio_duck_music")!);
    expect(LlmEditRequestSchema.safeParse(request).success).toBe(true);
    const plan = EditPlanResponseSchema.parse({
      request_id: request.request_id,
      status: "succeeded",
      summary: "duck",
      confidence: 0.8,
      requires_confirmation: true,
      operations: [{ id: "duck", type: "duck_music", target: { voice_track_id: "audio_main", music_track_id: "music" }, params: { duck_db: -9, attack_ms: 120, release_ms: 650, segments: [{ start_ms: 10000, end_ms: 45000, confidence: 0.91 }] }, rationale: "duck" }],
    });
    expect(validateEditPlanAgainstRequest(request, plan)).toBe(plan);
    expect(() => validateEditPlanAgainstRequest({ ...request, context: { ...request.context, available_operations: ["reduce_noise"] } }, plan)).toThrow("PLAN_OPERATION_NOT_AVAILABLE");
  });
});
