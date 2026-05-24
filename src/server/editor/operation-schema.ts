import { z } from "zod";

const TimeRangeShape = {
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
};

const OperationBaseSchema = z.object({
  id: z.string().min(1),
  rationale: z.string().min(1).max(1000),
});

export const OperationTypeSchema = z.enum([
  "trim_clip",
  "delete_range",
  "move_clip",
  "split_clip",
  "add_subtitle",
  "update_subtitle",
  "adjust_video",
  "adjust_audio",
  "set_export_preset",
]);

const EditOperationUnionSchema = z.discriminatedUnion("type", [
  OperationBaseSchema.extend({
    type: z.literal("trim_clip"),
    target: z.object({ clip_id: z.string().min(1) }),
    params: z.object({
        source_start_ms: z.number().int().nonnegative().optional(),
        source_end_ms: z.number().int().positive().optional(),
        timeline_start_ms: z.number().int().nonnegative().optional(),
        timeline_end_ms: z.number().int().positive().optional(),
      }),
  }),
  OperationBaseSchema.extend({
    type: z.literal("delete_range"),
    target: z.object({ ...TimeRangeShape, track_id: z.string().optional() }),
    params: z.object({ ripple: z.boolean().default(true) }),
  }),
  OperationBaseSchema.extend({
    type: z.literal("move_clip"),
    target: z.object({ clip_id: z.string().min(1) }),
    params: z.object({
      track_id: z.string().optional(),
      start_ms: z.number().int().nonnegative(),
    }),
  }),
  OperationBaseSchema.extend({
    type: z.literal("split_clip"),
    target: z.object({
      clip_id: z.string().min(1),
      at_ms: z.number().int().nonnegative(),
    }),
    params: z.object({}),
  }),
  OperationBaseSchema.extend({
    type: z.literal("add_subtitle"),
    target: z.object({ track_id: z.string().optional() }),
    params: z.object({
      ...TimeRangeShape,
      text: z.string().min(1).max(500),
      locale: z.enum(["zh-CN", "ja-JP", "en-US"]).default("zh-CN"),
    }),
  }),
  OperationBaseSchema.extend({
    type: z.literal("update_subtitle"),
    target: z.object({ subtitle_id: z.string().min(1) }),
    params: z.object({
        start_ms: z.number().int().nonnegative().optional(),
        end_ms: z.number().int().positive().optional(),
        text: z.string().min(1).max(500).optional(),
      }),
  }),
  OperationBaseSchema.extend({
    type: z.literal("adjust_video"),
    target: z.object({ clip_id: z.string().min(1) }),
    params: z.object({
      brightness: z.number().min(-1).max(1).optional(),
      contrast: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(-1).max(1).optional(),
    }),
  }),
  OperationBaseSchema.extend({
    type: z.literal("adjust_audio"),
    target: z.object({ clip_id: z.string().min(1) }),
    params: z.object({
      volume_db: z.number().min(-60).max(24).optional(),
      normalize: z.boolean().optional(),
      fade_in_ms: z.number().int().nonnegative().optional(),
      fade_out_ms: z.number().int().nonnegative().optional(),
      muted: z.boolean().optional(),
    }),
  }),
  OperationBaseSchema.extend({
    type: z.literal("set_export_preset"),
    target: z.object({ project_id: z.string().min(1) }),
    params: z.object({
      preset: z.enum(["source", "1080p_landscape", "1080p_portrait", "720p_preview"]),
    }),
  }),
]);

export const EditOperationSchema = EditOperationUnionSchema.superRefine((operation, ctx) => {
  const addRangeIssue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (operation.type === "delete_range" && operation.target.start_ms >= operation.target.end_ms) {
    addRangeIssue("start_ms must be before end_ms");
  }
  if (operation.type === "add_subtitle" && operation.params.start_ms >= operation.params.end_ms) {
    addRangeIssue("start_ms must be before end_ms");
  }
  if (
    operation.type === "trim_clip" &&
    operation.params.source_start_ms !== undefined &&
    operation.params.source_end_ms !== undefined &&
    operation.params.source_start_ms >= operation.params.source_end_ms
  ) {
    addRangeIssue("source_start_ms must be before source_end_ms");
  }
  if (
    operation.type === "trim_clip" &&
    operation.params.timeline_start_ms !== undefined &&
    operation.params.timeline_end_ms !== undefined &&
    operation.params.timeline_start_ms >= operation.params.timeline_end_ms
  ) {
    addRangeIssue("timeline_start_ms must be before timeline_end_ms");
  }
  if (
    operation.type === "update_subtitle" &&
    operation.params.start_ms !== undefined &&
    operation.params.end_ms !== undefined &&
    operation.params.start_ms >= operation.params.end_ms
  ) {
    addRangeIssue("start_ms must be before end_ms");
  }
});

export const EditOperationsSchema = z.array(EditOperationSchema);

export type OperationType = z.infer<typeof OperationTypeSchema>;
export type EditOperation = z.infer<typeof EditOperationSchema>;

export const AVAILABLE_OPERATIONS: OperationType[] = OperationTypeSchema.options;
