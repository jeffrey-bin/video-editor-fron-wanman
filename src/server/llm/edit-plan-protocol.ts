import { z } from "zod";
import { EditOperationSchema, OperationTypeSchema, type EditOperation } from "@/server/editor/operation-schema";

const ScopeUnionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("timeline"),
    start_ms: z.number().int().nonnegative().optional(),
    end_ms: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("selection"),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().positive(),
  }),
  z.object({ type: z.literal("clip"), clip_ids: z.array(z.string().min(1)).min(1) }),
  z.object({
    type: z.literal("subtitle"),
    subtitle_ids: z.array(z.string().min(1)).min(1).optional(),
    start_ms: z.number().int().nonnegative().optional(),
    end_ms: z.number().int().positive().optional(),
  }),
]);

export const ScopeSchema = ScopeUnionSchema.superRefine((value, ctx) => {
  if ("start_ms" in value && "end_ms" in value && value.start_ms !== undefined && value.end_ms !== undefined && value.start_ms >= value.end_ms) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope start_ms must be before end_ms" });
  }
});

export const MediaAssetContextSchema = z.object({
  id: z.string(),
  kind: z.enum(["video", "audio", "subtitle"]),
  originalName: z.string(),
  durationMs: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
});

export const ClipContextSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  kind: z.enum(["video", "audio", "subtitle", "ai"]),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  assetId: z.string().optional(),
  text: z.string().optional(),
});
const AudioSegmentSchema = z.object({
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  confidence: z.number().min(0).max(1).optional(),
});
const TranscriptSegmentSchema = AudioSegmentSchema.extend({
  text: z.string().min(1),
  source: z.enum(["mock", "fixture", "local_analyzer", "imported", "user"]).default("mock"),
  confidence: z.number().min(0).max(1),
});
const AudioContextSchema = z
  .object({
    tracks: z.array(z.object({
      track_id: z.string().min(1),
      kind: z.literal("audio"),
      role: z.enum(["voice", "music", "ambient", "mixed", "unknown"]),
      locked: z.boolean().default(false),
      muted: z.boolean().default(false),
      clips: z.array(z.string().min(1)),
    })).default([]),
    analysis: z.object({
      loudness_lufs: z.number().optional(),
      peak_dbfs: z.number().optional(),
      noise_floor_dbfs: z.number().optional(),
      speech_segments: z.array(AudioSegmentSchema).default([]),
      silence_segments: z.array(AudioSegmentSchema).default([]),
      transcript_segments: z.array(TranscriptSegmentSchema).default([]),
      av_sync_offset_ms: z.number().int().optional(),
      analysis_source: z.enum(["mock", "fixture", "local_analyzer", "none"]),
    }),
  })
  .superRefine((audio, ctx) => {
    const ranges = [...audio.analysis.speech_segments, ...audio.analysis.silence_segments, ...audio.analysis.transcript_segments];
    for (const segment of ranges) {
      if (segment.start_ms >= segment.end_ms) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "audio segment start_ms must be before end_ms" });
    }
  });

export const SubtitleCueSchema = z.object({
  id: z.string(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  text: z.string().min(1),
});

export const LlmEditRequestSchema = z.object({
  request_id: z.string().uuid(),
  project: z.object({
    project_id: z.string().min(1),
    duration_ms: z.number().int().nonnegative(),
    timeline_version: z.number().int().nonnegative(),
  }),
  user_intent: z.object({
    prompt: z.string().min(1).max(8000),
    locale: z.enum(["zh-CN", "ja-JP", "en-US"]),
    scope: ScopeSchema,
  }),
  context: z.object({
    assets: z.array(MediaAssetContextSchema),
    clips: z.array(ClipContextSchema),
    subtitles: z.array(SubtitleCueSchema),
    available_operations: z.array(OperationTypeSchema).min(1),
    audio: AudioContextSchema.optional(),
  }),
  constraints: z.object({
    max_operations: z.number().int().positive().max(100).default(50),
    require_user_confirmation: z.boolean().default(true),
    do_not_modify_source_files: z.literal(true),
  }),
});

const WarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const EditPlanResponseSchema = z
  .object({
    request_id: z.string().uuid(),
    status: z.enum(["succeeded", "failed", "partial"]),
    summary: z.string().max(2000),
    confidence: z.number().min(0).max(1),
    requires_confirmation: z.boolean(),
    warnings: z.array(WarningSchema).default([]),
    operations: z.array(EditOperationSchema).default([]),
    unsupported_intents: z.array(z.object({ intent: z.string(), reason: z.string() })).default([]),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "failed" && !value.error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "failed plans must include error" });
    }
    if (value.status === "failed" && value.operations.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "failed plans cannot include operations" });
    }
    if (value.status === "partial" && value.unsupported_intents.length === 0 && value.warnings.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "partial plans must include warnings or unsupported intents" });
    }
    if (value.confidence < 0.6 && !value.requires_confirmation) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "low confidence plans require confirmation" });
    }
  });

export type LlmEditRequest = z.infer<typeof LlmEditRequestSchema>;
export type EditPlanResponse = z.infer<typeof EditPlanResponseSchema>;

export const validateEditPlanAgainstRequest = (request: LlmEditRequest, plan: EditPlanResponse) => {
  const unavailable = plan.operations.find((operation) => !request.context.available_operations.includes(operation.type));
  if (unavailable) throw new Error(`PLAN_OPERATION_NOT_AVAILABLE:${unavailable.type}`);
  const hasHighRisk = plan.operations.some((operation) => {
    if (operation.type === "reduce_noise") return operation.params.strength > 0.7;
    if (operation.type === "equalize_loudness") return operation.params.max_gain_db > 9 || operation.params.limit_peak_dbfs > -1;
    if (operation.type === "shift_audio") return Math.abs(operation.params.offset_ms) > 1000;
    return false;
  });
  const hasLowConfidenceSubtitle = plan.operations.some((operation: EditOperation) =>
    (operation.type === "add_subtitle" || operation.type === "update_subtitle") && operation.params.confidence !== undefined && operation.params.confidence < 0.85,
  );
  if ((hasHighRisk || hasLowConfidenceSubtitle) && !plan.requires_confirmation) {
    throw new Error("PLAN_REQUIRES_CONFIRMATION");
  }
  return plan;
};
