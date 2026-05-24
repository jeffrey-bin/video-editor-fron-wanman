import { describe, expect, it } from "vitest";
import { analyzeSamples } from "@/server/media-quality/audio-metrics";
import { assertAudioNotEmpty, assertFadeTrend, assertHashChanged, assertSegmentDeltaAtMost, assertSegmentRmsAtMost, assertVideoBrightened, assertVideoNotPlaceholder } from "@/server/media-quality/p5-assertions";
import { P5_PROMPT_CASES, P5_SMOKE_CASE_IDS } from "@/server/media-quality/p5-cases";
import { P5FixtureManifestSchema, P5PromptCaseSchema, P5ReportSchema } from "@/server/media-quality/p5-schemas";
import { analyzeRgbFrame } from "@/server/media-quality/video-metrics";

describe("P5 real media quality schemas and assertions", () => {
  it("declares the required 24+ prompt polish cases including smoke cases", () => {
    expect(P5_PROMPT_CASES.length).toBeGreaterThanOrEqual(24);
    for (const id of P5_SMOKE_CASE_IDS) expect(P5_PROMPT_CASES.some((qualityCase) => qualityCase.id === id)).toBe(true);
    expect(P5_PROMPT_CASES.map((qualityCase) => P5PromptCaseSchema.parse(qualityCase).id)).toContain("p5_mixed_track_unsupported_001");
    expect(P5_PROMPT_CASES.find((qualityCase) => qualityCase.id === "p5_mixed_track_unsupported_001")).toMatchObject({
      expectedProviderStatus: "partial",
      expectedFailureCode: "MEDIA_UNSUPPORTED_SEMANTIC",
    });
  });

  it("rejects unsafe fixture manifests with duplicate ids and path traversal", () => {
    const manifest = {
      version: 1,
      generated_by: "scripts/generate-p5-media-fixtures.mjs",
      fixtures: Array.from({ length: 10 }, (_value, index) => ({
        id: index < 2 ? "duplicate" : `fixture_${index}`,
        kind: "audio",
        path: index === 3 ? "../secret.wav" : `tests/fixtures/media/audio/fixture_${index}.wav`,
        duration_ms: 1000,
        sample_rate: 48000,
        channels: 1,
        license: "project-generated",
        purpose: ["test"],
        baseline_metrics: { rms_dbfs: -18 },
      })),
    };
    expect(P5FixtureManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("computes deterministic audio RMS, segment deltas, silence and fade trends", () => {
    const sampleRate = 10;
    const samples = new Float32Array([0.1, 0.1, 0.1, 0.1, 0, 0, 0, 0, 0.6, 0.5, 0.4, 0.3]);
    const metrics = analyzeSamples(samples, sampleRate, {
      segments: {
        quiet: { startMs: 0, endMs: 400 },
        muted: { startMs: 400, endMs: 800 },
        loud: { startMs: 800, endMs: 1200 },
      },
      fade: { direction: "out", startMs: 800, endMs: 1200, windowMs: 100 },
    });
    expect(assertAudioNotEmpty(metrics).passed).toBe(true);
    expect(assertSegmentRmsAtMost("muted", metrics, "muted", -60).passed).toBe(true);
    expect(assertSegmentDeltaAtMost("delta", metrics, "quiet", "loud", 20).passed).toBe(true);
    expect(assertFadeTrend(metrics).passed).toBe(true);
  });

  it("detects non-placeholder video frames and brightness changes", () => {
    const dark = new Uint8Array([
      20, 20, 20, 40, 40, 40,
      70, 30, 30, 90, 90, 90,
    ]);
    const bright = new Uint8Array([
      35, 35, 35, 55, 55, 55,
      85, 45, 45, 105, 105, 105,
    ]);
    const before = { durationMs: 1000, width: 2, height: 2, frameRate: 24, sampledFrames: [analyzeRgbFrame(dark, 2, 2, 10)] };
    const after = { durationMs: 1000, width: 2, height: 2, frameRate: 24, sampledFrames: [analyzeRgbFrame(bright, 2, 2, 10)] };
    expect(assertVideoNotPlaceholder(before, 1).passed).toBe(true);
    expect(assertVideoBrightened(before, after, 0.05, 0.35).passed).toBe(true);
  });

  it("marks unchanged output hash as a hard measurable-change failure", () => {
    expect(assertHashChanged("same", "same").failure_code).toBe("MEDIA_NO_MEASURABLE_CHANGE");
    expect(assertHashChanged("input", "output").passed).toBe(true);
  });

  it("validates the machine-readable P5 report shape", () => {
    const report = P5ReportSchema.parse({
      schema: "promptcut.p5-real-media-report",
      version: 1,
      run_id: "p5-real-media-test",
      provider: "mock",
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, hard_failures: 0 },
      environment: { ffmpeg_version: "ffmpeg test", ffprobe_version: "ffprobe test", node_version: process.version, ci: false },
      cases: [
        {
          case_id: "p5_audio_loudness_001",
          fixture_ids: ["voice_quiet_loud_12s"],
          prompt: "统一音量",
          status: "passed",
          provider_status: "succeeded",
          operations: ["equalize_loudness"],
          input_sha256: "in",
          output_sha256: "out",
          output_path: "test-results/p5-media/mock/p5_audio_loudness_001/output.wav",
          metrics_before: {},
          metrics_after: {},
          assertions: [{ name: "output_hash_changed", passed: true }],
          failure_code: null,
          warnings: [],
        },
      ],
    });
    expect(report.cases[0]?.output_path).not.toContain("/home/");
  });

  it("keeps every P5 case assertion mapped to an explicit report assertion name", () => {
    const runnerAssertionNames = new Set([
      "output_hash_changed",
      "audio_not_empty",
      "video_not_placeholder",
      "integrated_lufs",
      "true_peak_dbfs_max",
      "segment_rms_delta_db_max",
      "mute_segment_rms_max",
      "mute_boundaries_preserved",
      "mute_boundary_jump_db",
      "duck_music_delta_db",
      "duck_release_baseline_delta_db",
      "duck_voice_rms_delta_db",
      "fade_trend",
      "fade_duration_ms",
      "fade_outside_300ms_delta_db",
      "noise_floor_reduced_db",
      "speech_rms_preserved",
      "video_brightened",
      "video_saturation_increased",
      "unsupported_mixed_track",
    ]);
    const missing = P5_PROMPT_CASES.flatMap((qualityCase) =>
      qualityCase.assertions
        .filter((item) => !runnerAssertionNames.has(item.name))
        .map((item) => `${qualityCase.id}:${item.name}`),
    );
    expect(missing).toEqual([]);
  });
});
