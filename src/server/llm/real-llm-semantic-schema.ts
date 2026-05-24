import { z } from "zod";
import { OperationTypeSchema } from "@/server/editor/operation-schema";

export const TimeRangeSchema = z.object({
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  confidence: z.number().min(0).max(1).optional(),
}).superRefine((range, ctx) => {
  if (range.start_ms >= range.end_ms) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "start_ms must be before end_ms" });
});

export const TranscriptSegmentSchema = TimeRangeSchema.extend({
  text: z.string().min(1),
  source: z.enum(["mock", "fixture", "local_analyzer", "imported", "user"]).default("fixture"),
  confidence: z.number().min(0).max(1),
});

export const RealLlmSemanticCaseSchema = z.object({
  case_id: z.string().regex(/^llm_semantic_[a-z]+_\d{3}$/),
  prompt_zh: z.string().min(1).max(8000),
  fixture_id: z.enum(["talking_head_demo_60s", "podcast_mix_90s", "product_intro_45s"]),
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("timeline"), start_ms: z.number().int().nonnegative().optional(), end_ms: z.number().int().positive().optional() }),
    z.object({ type: z.literal("selection"), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive() }),
    z.object({ type: z.literal("clip"), clip_ids: z.array(z.string().min(1)).min(1) }),
    z.object({ type: z.literal("subtitle"), subtitle_ids: z.array(z.string().min(1)).optional(), start_ms: z.number().int().nonnegative().optional(), end_ms: z.number().int().positive().optional() }),
  ]),
  timeline_context: z.object({
    duration_ms: z.number().int().positive(),
    timeline_version: z.number().int().nonnegative(),
    tracks: z.array(z.object({ id: z.string(), kind: z.enum(["video", "audio", "subtitle", "ai"]), role: z.enum(["voice", "music", "ambient", "mixed", "unknown"]).optional(), locked: z.boolean().default(false) })),
    clips: z.array(z.object({ id: z.string(), track_id: z.string(), kind: z.enum(["video", "audio", "subtitle", "ai"]), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive(), text: z.string().optional() })),
    subtitles: z.array(z.object({ id: z.string(), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive(), text: z.string() })).default([]),
    audio_analysis: z.object({
      analysis_source: z.enum(["fixture", "mock", "local_analyzer", "none"]),
      speech_segments: z.array(TimeRangeSchema).default([]),
      silence_segments: z.array(TimeRangeSchema).default([]),
      transcript_segments: z.array(TranscriptSegmentSchema).default([]),
      events: z.array(z.object({ type: z.enum(["cough", "pause", "product_intro", "price_repeat"]), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive(), confidence: z.number().min(0).max(1) })).default([]),
    }).optional(),
    visual_annotations: z.array(z.object({ type: z.enum(["person_bbox", "ppt_region", "dark_region"]), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive(), bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional() })).default([]),
  }),
  available_operations: z.array(OperationTypeSchema).min(1),
  expected_status: z.enum(["succeeded", "partial", "failed"]),
  risk_tags: z.array(z.enum(["ambiguous_time", "conflict", "destructive_delete", "unsupported_generation", "source_file_protection", "mixed_track", "subjective_polish", "subtitle_rewrite", "entity_preservation", "multi_step", "operation_not_available"])).min(1),
});

export const ExpectedValueMatcherSchema = z.union([
  z.object({ equals: z.unknown() }),
  z.object({ one_of: z.array(z.unknown()).min(1) }),
  z.object({ range: z.tuple([z.number(), z.number()]) }),
  z.object({ includes: z.string() }),
  z.object({ absent: z.literal(true) }),
]);

export const ExpectedOperationSchema = z.object({
  type: OperationTypeSchema,
  target: z.record(z.unknown()).optional(),
  params: z.record(z.unknown()).optional(),
  order_index: z.number().int().nonnegative().optional(),
});

export const ExpectedRealLlmSemanticPlanSchema = z.object({
  case_id: z.string(),
  expected_status: z.enum(["succeeded", "partial", "failed"]),
  must_require_confirmation: z.boolean(),
  min_confidence: z.number().min(0).max(1).optional(),
  max_confidence: z.number().min(0).max(1).optional(),
  expected_operations: z.array(ExpectedOperationSchema).default([]),
  forbidden_operations: z.array(OperationTypeSchema).default([]),
  expected_warning_codes: z.array(z.string()).default([]),
  expected_error_code: z.string().optional(),
  expected_unsupported_intents: z.array(z.string()).default([]),
  semantic_assertions: z.array(z.enum([
    "request_id_echoed",
    "failed_has_no_operations",
    "partial_explains_reason",
    "destructive_requires_confirmation",
    "does_not_modify_source",
    "does_not_guess_unannotated_time",
    "keeps_protected_range",
    "preserves_product_names_and_numbers",
    "audio_only_does_not_delete_video",
    "mixed_track_not_faked_as_success",
    "unsupported_generation_not_mapped_to_fake_filter",
    "multi_step_order_preserved",
    "export_preset_does_not_start_export",
  ])).min(1),
});

export const NormalizedRealLlmPlanSchema = z.object({
  case_id: z.string(),
  provider: z.enum(["mock", "codex-cli"]),
  status: z.enum(["succeeded", "partial", "failed"]),
  requires_confirmation: z.boolean(),
  operation_types: z.array(OperationTypeSchema),
  operations: z.array(z.object({ type: OperationTypeSchema, target: z.record(z.unknown()), params: z.record(z.unknown()) })),
  warning_codes: z.array(z.string()),
  error_code: z.string().nullable(),
  unsupported_intents: z.array(z.string()),
  questions: z.array(z.string()).default([]),
});

export const RealLlmSemanticReportSchema = z.object({
  schema: z.literal("promptcut.real-llm-semantic-quality-report"),
  version: z.literal(1),
  run_id: z.string(),
  suite: z.enum(["smoke", "full"]),
  providers: z.array(z.enum(["mock", "codex-cli"])),
  summary: z.object({
    total_cases: z.number().int().nonnegative(),
    passed_cases: z.number().int().nonnegative(),
    failed_cases: z.number().int().nonnegative(),
    hard_failures: z.number().int().nonnegative(),
    average_score: z.number(),
    schema_valid_rate: z.number().min(0).max(1),
    timeline_safety_failures: z.number().int().nonnegative(),
    high_risk_confirmation_pass_rate: z.number().min(0).max(1),
    provider_consistency_rate: z.number().min(0).max(1),
    real_secret_usage_count: z.number().int().nonnegative(),
  }),
  environment: z.object({
    node_version: z.string(),
    ci: z.boolean(),
    codex_cli_available: z.boolean(),
    codex_cli_bin: z.string().nullable(),
    network_allowed: z.literal(false),
    real_llm_keys_present: z.boolean(),
  }),
  cases: z.array(z.unknown()),
  failures: z.array(z.object({ case_id: z.string(), provider: z.string(), reason: z.string() })),
});

export type RealLlmSemanticCase = z.infer<typeof RealLlmSemanticCaseSchema>;
export type ExpectedRealLlmSemanticPlan = z.infer<typeof ExpectedRealLlmSemanticPlanSchema>;
export type NormalizedRealLlmPlan = z.infer<typeof NormalizedRealLlmPlanSchema>;
export type RealLlmSemanticReport = z.infer<typeof RealLlmSemanticReportSchema>;

