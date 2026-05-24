import { z } from "zod";

export const P5FailureCodeSchema = z.enum([
  "MEDIA_FIXTURE_MISSING",
  "MEDIA_DECODE_FAILED",
  "MEDIA_RENDER_FAILED",
  "MEDIA_OUTPUT_EMPTY",
  "MEDIA_ASSERTION_FAILED",
  "MEDIA_NO_MEASURABLE_CHANGE",
  "MEDIA_UNSUPPORTED_SEMANTIC",
  "MEDIA_AMBIGUOUS_TARGET",
  "MEDIA_ANALYSIS_UNAVAILABLE",
  "MEDIA_PROVIDER_INVALID_PLAN",
]);

const repoMediaPath = z.string().regex(/^tests\/fixtures\/media\/(audio|video)\/[a-z0-9_.-]+\.(wav|mp4)$/);

export const P5FixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  kind: z.enum(["audio", "video"]),
  path: repoMediaPath,
  duration_ms: z.number().int().positive(),
  sample_rate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frame_rate: z.number().positive().optional(),
  license: z.literal("project-generated"),
  purpose: z.array(z.string().min(1)).min(1),
  baseline_metrics: z.record(z.unknown()),
});

export const P5FixtureManifestSchema = z
  .object({
    version: z.literal(1),
    generated_by: z.literal("scripts/generate-p5-media-fixtures.mjs"),
    fixtures: z.array(P5FixtureSchema).min(10),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const fixture of manifest.fixtures) {
      if (seen.has(fixture.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate fixture id ${fixture.id}` });
      seen.add(fixture.id);
      if (fixture.kind === "audio" && (!fixture.sample_rate || !fixture.channels)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `audio fixture ${fixture.id} requires sample_rate and channels` });
      }
      if (fixture.kind === "video" && (!fixture.width || !fixture.height || !fixture.frame_rate)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `video fixture ${fixture.id} requires width, height and frame_rate` });
      }
    }
  });

export const P5PromptCaseSchema = z.object({
  id: z.string().regex(/^p5_[a-z0-9_]+$/),
  fixtureIds: z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1),
  provider: z.enum(["mock", "codex-cli", "both"]),
  prompt: z.string().min(1),
  scope: z.object({
    mode: z.enum(["timeline", "selection"]),
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().positive().optional(),
  }),
  expectedProviderStatus: z.enum(["succeeded", "partial", "failed"]),
  expectedOperations: z.array(z.string().min(1)),
  assertions: z.array(z.object({ name: z.string().min(1), params: z.record(z.unknown()).default({}) })).min(1),
  expectedFailureCode: P5FailureCodeSchema.optional(),
});

export const P5ReportCaseSchema = z.object({
  case_id: z.string(),
  fixture_ids: z.array(z.string()),
  prompt: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  provider_status: z.enum(["succeeded", "partial", "failed", "skipped"]),
  operations: z.array(z.string()),
  input_sha256: z.string().nullable(),
  output_sha256: z.string().nullable(),
  output_path: z.string().nullable(),
  metrics_before: z.record(z.unknown()),
  metrics_after: z.record(z.unknown()),
  assertions: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    actual: z.unknown().optional(),
    target: z.unknown().optional(),
    tolerance: z.number().optional(),
    failure_code: P5FailureCodeSchema.nullable().optional(),
  })),
  failure_code: P5FailureCodeSchema.nullable(),
  warnings: z.array(z.string()),
});

export const P5ReportSchema = z.object({
  schema: z.literal("promptcut.p5-real-media-report"),
  version: z.literal(1),
  run_id: z.string(),
  provider: z.enum(["mock", "codex-cli"]),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    hard_failures: z.number().int().nonnegative(),
  }),
  environment: z.object({
    ffmpeg_version: z.string(),
    ffprobe_version: z.string(),
    node_version: z.string(),
    ci: z.boolean(),
  }),
  cases: z.array(P5ReportCaseSchema),
});

export type P5FailureCode = z.infer<typeof P5FailureCodeSchema>;
export type P5Fixture = z.infer<typeof P5FixtureSchema>;
export type P5FixtureManifest = z.infer<typeof P5FixtureManifestSchema>;
export type P5PromptCase = z.infer<typeof P5PromptCaseSchema>;
export type P5Report = z.infer<typeof P5ReportSchema>;
