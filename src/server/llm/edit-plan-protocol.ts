import { z } from "zod";
import { EditOperationSchema, OperationTypeSchema } from "@/server/editor/operation-schema";

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
