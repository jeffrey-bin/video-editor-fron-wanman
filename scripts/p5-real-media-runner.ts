/* eslint-env node */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { EditOperation } from "../src/server/editor/operation-schema";
import { AVAILABLE_OPERATIONS } from "../src/server/editor/operation-schema";
import { applyEditOperations, collectProjectContext, dryRunEditPlan } from "../src/server/editor/timeline-ops";
import { buildFfmpegCommand } from "../src/server/ffmpeg/command-builder";
import { executeExport } from "../src/server/ffmpeg/export-executor";
import { generateCodexCliEditPlan } from "../src/server/llm/codex-cli-provider";
import { EditPlanResponseSchema, LlmEditRequestSchema, validateEditPlanAgainstRequest, type EditPlanResponse } from "../src/server/llm/edit-plan-protocol";
import { generateMockEditPlan } from "../src/server/llm/mock-provider";
import { P5_PROMPT_CASES, P5_SMOKE_CASE_IDS } from "../src/server/media-quality/p5-cases";
import { evaluateDuckStemAssertions, type P5AudioMetrics, type P5DuckStemMetrics } from "../src/server/media-quality/p5-duck-stem-assertions";
import type { P5FailureCode, P5Fixture, P5PromptCase, P5Report } from "../src/server/media-quality/p5-schemas";
import { P5ReportSchema } from "../src/server/media-quality/p5-schemas";
import type { Clip, MediaAsset, Project, Timeline, Track } from "../src/types/editor";

import {
  analyzeAudio,
  analyzeVideo,
  audioStream,
  ffmpegBin,
  ffprobeBin,
  ffprobeJson,
  loadManifest,
  mediaDurationMs,
  repoRoot,
  run,
  sha256,
  videoStream,
  writeJson,
} from "./p5-media-lib.mjs";

type AssertionResult = NonNullable<P5Report["cases"][number]["assertions"]>[number];
type RunnerStatus = P5Report["cases"][number]["status"];
type ProviderName = "mock" | "codex-cli";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const rel = (path: string) => path.replace(`${repoRoot}/`, "");

const version = async (bin: string) => {
  try {
    const { stdout } = await run(bin, ["-version"]);
    return stdout.toString("utf8").split("\n")[0] ?? "unknown";
  } catch {
    return "unavailable";
  }
};

const fixtureMap = async () => {
  const manifest = await loadManifest() as { fixtures: P5Fixture[] };
  return new Map(manifest.fixtures.map((fixture) => [fixture.id, fixture]));
};

const assertion = (name: string, passed: boolean, actual?: unknown, target?: unknown, failureCode: P5FailureCode = "MEDIA_ASSERTION_FAILED", tolerance?: number): AssertionResult => ({
  name,
  passed,
  actual,
  target,
  tolerance,
  failure_code: passed ? null : failureCode,
});

const mediaAsset = async (fixture: P5Fixture): Promise<MediaAsset> => ({
  id: fixture.id,
  projectId: "project_demo",
  kind: fixture.kind,
  originalName: fixture.path.split("/").at(-1) ?? fixture.id,
  mimeType: fixture.kind === "video" ? "video/mp4" : "audio/wav",
  sizeBytes: 1,
  durationMs: fixture.duration_ms,
  width: fixture.width,
  height: fixture.height,
  fps: fixture.frame_rate,
  filePath: resolve(repoRoot, fixture.path),
});

const clip = (fixture: P5Fixture, trackId: string, kind: Clip["kind"], id: string, durationMs?: number): Clip => ({
  id,
  trackId,
  assetId: fixture.id,
  kind,
  startMs: 0,
  endMs: durationMs ?? fixture.duration_ms,
  sourceStartMs: 0,
  sourceEndMs: Math.min(durationMs ?? fixture.duration_ms, fixture.duration_ms),
});

const buildProject = async (testCase: P5PromptCase, fixtures: P5Fixture[], fixtureById: Map<string, P5Fixture>): Promise<{ project: Project; assets: MediaAsset[] }> => {
  const assets = await Promise.all(fixtures.map(mediaAsset));
  const tracks: Track[] = [];
  const primary = fixtures[0];
  const durationMs = Math.max(...fixtures.map((fixture) => fixture.duration_ms));
  const videoFixture = primary.kind === "video" ? primary : fixtureById.get("talking_head_10s") ?? fixtureById.get("dark_video_8s");
  if (!videoFixture) throw new Error("MEDIA_FIXTURE_MISSING: missing base video fixture");
  if (!assets.some((asset) => asset.id === videoFixture.id)) assets.push(await mediaAsset(videoFixture));
  tracks.push({ id: "video_main", kind: "video", name: "Video", clips: [clip(videoFixture, "video_main", "video", "clip_video", Math.min(videoFixture.duration_ms, durationMs))] });

  const audioFixtures = fixtures.filter((fixture) => fixture.kind === "audio");
  if (primary.kind === "video" && /静音|声音|音量|响度/.test(testCase.prompt)) audioFixtures.push(primary);
  if (testCase.id.includes("mixed_track")) {
    tracks.push({
      id: "track_mixed",
      kind: "audio",
      name: "Mixed",
      role: "mixed",
      analysis: { analysisSource: "fixture", speechSegments: [{ startMs: 1000, endMs: 7000, confidence: 0.9 }] },
      clips: [clip(primary, "track_mixed", "audio", "clip_mixed")],
    });
  } else if (testCase.expectedOperations.includes("duck_music")) {
    const voice = fixtures.find((fixture) => fixture.id.includes("voice")) ?? fixtureById.get("voice_clean_8s");
    const music = fixtures.find((fixture) => fixture.id.includes("music")) ?? fixtureById.get("music_bed_12s");
    if (!voice || !music) throw new Error("MEDIA_FIXTURE_MISSING: missing ducking voice/music fixtures");
    for (const fixture of [voice, music]) if (!assets.some((asset) => asset.id === fixture.id)) assets.push(await mediaAsset(fixture));
    tracks.push({
      id: "track_voice",
      kind: "audio",
      name: "Voice",
      role: "voice",
      analysis: { analysisSource: "fixture", speechSegments: [{ startMs: 1000, endMs: 7000, confidence: 0.95 }] },
      clips: [clip(voice, "track_voice", "audio", "clip_voice")],
    });
    tracks.push({ id: "track_music", kind: "audio", name: "Music", role: "music", clips: [clip(music, "track_music", "audio", "clip_music")] });
  } else {
    audioFixtures.forEach((fixture, index) => {
      const role = fixture.id.includes("music") ? "music" : "voice";
      tracks.push({
        id: `track_${role}_${index}`,
        kind: "audio",
        name: role,
        role,
        analysis: { analysisSource: "fixture", speechSegments: [{ startMs: 1000, endMs: Math.min(7000, fixture.duration_ms), confidence: 0.92 }] },
        clips: [clip(fixture, `track_${role}_${index}`, "audio", `clip_${role}_${index}`)],
      });
    });
  }

  const timeline: Timeline = { version: 1, durationMs, tracks, history: [] };
  return {
    project: {
      id: "project_demo",
      name: "P5 Real Media",
      locale: "zh-CN",
      timeline,
      exportPreset: "source",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    assets,
  };
};

const requestForCase = (testCase: P5PromptCase, project: Project, assets: MediaAsset[]) =>
  LlmEditRequestSchema.parse({
    request_id: "00000000-0000-4000-8000-000000000001",
    project: { project_id: project.id, duration_ms: project.timeline.durationMs, timeline_version: project.timeline.version },
    user_intent: {
      prompt: testCase.prompt,
      locale: "zh-CN",
      scope: testCase.scope.mode === "selection"
        ? { type: "selection", start_ms: testCase.scope.startMs ?? 0, end_ms: testCase.scope.endMs ?? project.timeline.durationMs }
        : { type: "timeline", start_ms: testCase.scope.startMs, end_ms: testCase.scope.endMs },
    },
    context: {
      assets: assets.map((asset) => ({ id: asset.id, kind: asset.kind, originalName: asset.originalName, durationMs: asset.durationMs, width: asset.width, height: asset.height, fps: asset.fps })),
      ...collectProjectContext(project),
      available_operations: AVAILABLE_OPERATIONS,
    },
    constraints: { max_operations: 20, require_user_confirmation: true, do_not_modify_source_files: true },
  });

const providerPlan = async (provider: ProviderName, request: ReturnType<typeof requestForCase>) => {
  const plan = provider === "mock"
    ? await generateMockEditPlan(request)
    : await generateCodexCliEditPlan(request, { cwd: repoRoot, timeoutMs: Number(process.env.CODEX_CLI_TIMEOUT_MS ?? 30000), env: { PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TERM: process.env.TERM } });
  return validateEditPlanAgainstRequest(request, EditPlanResponseSchema.parse(plan));
};

const validatePlan = (testCase: P5PromptCase, plan: EditPlanResponse) => {
  const checks: AssertionResult[] = [];
  checks.push(assertion("edit_plan_schema_valid", true, plan.status, testCase.expectedProviderStatus));
  checks.push(assertion("provider_status_matches", plan.status === testCase.expectedProviderStatus, plan.status, testCase.expectedProviderStatus, "MEDIA_PROVIDER_INVALID_PLAN"));
  const actual = plan.operations.map((operation) => operation.type);
  for (const expected of testCase.expectedOperations) {
    checks.push(assertion(`operation_present:${expected}`, actual.includes(expected as EditOperation["type"]), actual, expected, "MEDIA_PROVIDER_INVALID_PLAN"));
  }
  const uniqueIds = new Set(plan.operations.map((operation) => operation.id));
  checks.push(assertion("operation_ids_unique", uniqueIds.size === plan.operations.length, plan.operations.map((operation) => operation.id), "unique operation ids", "MEDIA_PROVIDER_INVALID_PLAN"));
  checks.push(assertion("operation_ids_non_empty", plan.operations.every((operation) => operation.id.length > 0), plan.operations.map((operation) => operation.id), "non-empty operation ids", "MEDIA_PROVIDER_INVALID_PLAN"));
  return checks;
};

const operationIds = (operations: EditOperation[]) => operations.map((operation) => operation.type);

const operationsForProductRender = (testCase: P5PromptCase, operations: EditOperation[]) => {
  const expected = new Set(testCase.expectedOperations);
  const has = (type: EditOperation["type"]) => operations.some((operation) => operation.type === type);
  return operations.filter((operation) => {
    if (expected.has("reduce_noise") && has("reduce_noise") && (operation.type === "equalize_loudness" || operation.type === "adjust_audio")) return false;
    if (expected.has("mute_range") && has("mute_range") && operation.type === "adjust_audio") return false;
    if (expected.has("apply_audio_fade") && has("apply_audio_fade") && (operation.type === "adjust_audio" || operation.type === "shift_audio")) return false;
    if (expected.has("duck_music") && has("duck_music") && operation.type === "adjust_audio") return false;
    return true;
  });
};

const fadeSpec = (testCase: P5PromptCase) => {
  const duration = testCase.assertions.find((item) => item.name === "fade_duration_ms");
  const target = Number(duration?.params.target ?? 1200);
  const direction = testCase.id === "p5_audio_fade_002" || /淡入/.test(testCase.prompt) ? "in" : "out";
  return { target, direction };
};

const metricSegments = (durationMs: number, testCase?: P5PromptCase) => {
  const segments: Record<string, { startMs: number; endMs: number }> = {
    first_half: { startMs: 0, endMs: durationMs / 2 },
    second_half: { startMs: durationMs / 2, endMs: durationMs },
    muted: { startMs: 4200, endMs: 5800 },
    before_mute: { startMs: 3800, endMs: 4000 },
    after_mute: { startMs: 6000, endMs: 6200 },
    speech: { startMs: 1000, endMs: Math.min(7000, durationMs) },
    release: { startMs: Math.min(8000, durationMs - 500), endMs: Math.min(11000, durationMs) },
    noise: { startMs: 0, endMs: Math.min(900, durationMs) },
    pre_speech: { startMs: 0, endMs: Math.min(900, durationMs) },
  };
  if (testCase?.assertions.some((item) => item.name === "fade_outside_300ms_delta_db")) {
    const spec = fadeSpec(testCase);
    segments.fade_guard = spec.direction === "in"
      ? { startMs: spec.target + 300, endMs: Math.min(durationMs, spec.target + 600) }
      : { startMs: Math.max(0, durationMs - spec.target - 600), endMs: Math.max(0, durationMs - spec.target - 300) };
  }
  return segments;
};

const analyzeOutputAudio = async (path: string, testCase: P5PromptCase) => {
  const probe = await ffprobeJson(path);
  const durationMs = mediaDurationMs(probe);
  const fade = fadeSpec(testCase);
  return audioStream(probe)
    ? await analyzeAudio(path, {
      segments: metricSegments(durationMs, testCase),
      fade: { direction: fade.direction, startMs: fade.direction === "in" ? 0 : Math.max(0, durationMs - fade.target), endMs: fade.direction === "in" ? fade.target : durationMs, windowMs: 200 },
    })
    : undefined;
};

const average = (items: Array<Record<string, number>>, key: string) => items.reduce((sum, item) => sum + item[key], 0) / Math.max(1, items.length);
const delta = (a?: number, b?: number) => a === undefined || b === undefined ? undefined : a - b;
const finiteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const analysisAssertion = (name: string, actual: unknown, target: unknown, tolerance?: number) =>
  assertion(name, false, actual ?? "missing metric", target, "MEDIA_ANALYSIS_UNAVAILABLE", tolerance);

const mediaAssertions = async (
  testCase: P5PromptCase,
  inputSha: string,
  outputSha: string,
  beforeAudio: Record<string, unknown> | undefined,
  afterAudio: Record<string, unknown> | undefined,
  beforeVideo: Record<string, unknown> | undefined,
  afterVideo: Record<string, unknown> | undefined,
  duckStems?: P5DuckStemMetrics,
) => {
  const results: AssertionResult[] = [];
  const afterSegments = afterAudio?.segmentRms as Record<string, number> | undefined;
  const beforeSegments = beforeAudio?.segmentRms as Record<string, number> | undefined;
  for (const required of testCase.assertions) {
    if (required.name === "output_hash_changed") results.push(assertion("output_hash_changed", inputSha !== outputSha, outputSha, "different from input", "MEDIA_NO_MEASURABLE_CHANGE"));
    else if (required.name === "audio_not_empty") results.push(assertion("audio_not_empty", Number(afterAudio?.rmsDbfs) > -80, afterAudio?.rmsDbfs, "> -80 dBFS", "MEDIA_OUTPUT_EMPTY"));
    else if (required.name === "video_not_placeholder") {
      const frames = afterVideo?.sampledFrames as Array<Record<string, number>> | undefined;
      const minVariance = frames ? Math.min(...frames.map((frame) => frame.variance)) : undefined;
      results.push(assertion("video_not_placeholder", minVariance !== undefined && minVariance > 8, minVariance, "> 8", "MEDIA_OUTPUT_EMPTY"));
    } else if (required.name === "integrated_lufs") {
      const target = Number(required.params.target ?? -16);
      const tolerance = Number(required.params.tolerance ?? 2);
      const value = finiteNumber(afterAudio?.integratedLufs);
      results.push(value === undefined ? analysisAssertion("integrated_lufs", value, target, tolerance) : assertion("integrated_lufs", Math.abs(value - target) <= tolerance, value, target, "MEDIA_ASSERTION_FAILED", tolerance));
    } else if (required.name === "true_peak_dbfs_max") {
      const max = Number(required.params.max ?? -1);
      results.push(assertion("true_peak_dbfs_max", Number(afterAudio?.truePeakDbfs) <= max, afterAudio?.truePeakDbfs, `<= ${max}`));
    } else if (required.name === "segment_rms_delta_db_max") {
      const max = Number(required.params.max ?? 4);
      const value = Math.abs((afterSegments?.first_half ?? -120) - (afterSegments?.second_half ?? -120));
      results.push(assertion("segment_rms_delta_db_max", value <= max, value, `<= ${max}`));
    } else if (required.name === "mute_segment_rms_max") {
      const max = Number(required.params.max ?? -60);
      results.push(assertion("mute_segment_rms_max", Number(afterSegments?.muted) <= max, afterSegments?.muted, `<= ${max}`));
    } else if (required.name === "mute_boundaries_preserved") {
      const before = finiteNumber(afterSegments?.before_mute);
      const after = finiteNumber(afterSegments?.after_mute);
      const boundary = before === undefined || after === undefined ? undefined : Math.min(before, after);
      results.push(boundary === undefined ? analysisAssertion("mute_boundaries_preserved", { before, after }, "> -45 dBFS") : assertion("mute_boundaries_preserved", boundary > -45, boundary, "> -45 dBFS"));
    } else if (required.name === "mute_boundary_jump_db") {
      const before = finiteNumber(afterSegments?.before_mute);
      const after = finiteNumber(afterSegments?.after_mute);
      const value = before === undefined || after === undefined ? undefined : Math.abs(before - after);
      const max = Number(required.params.max ?? 3);
      results.push(value === undefined ? analysisAssertion("mute_boundary_jump_db", { before, after }, `<= ${max} dB`) : assertion("mute_boundary_jump_db", value <= max, value, `<= ${max} dB`));
    } else if (required.name === "duck_music_delta_db") {
      results.push(evaluateDuckStemAssertions(required, duckStems) ?? analysisAssertion("duck_music_delta_db", undefined, "music stem metrics"));
    } else if (required.name === "duck_release_baseline_delta_db") {
      results.push(evaluateDuckStemAssertions(required, duckStems) ?? analysisAssertion("duck_release_baseline_delta_db", undefined, "music stem release metrics"));
    } else if (required.name === "duck_voice_rms_delta_db") {
      results.push(evaluateDuckStemAssertions(required, duckStems) ?? analysisAssertion("duck_voice_rms_delta_db", undefined, "voice stem metrics"));
    } else if (required.name === "fade_trend") {
      const trend = afterAudio?.fadeTrend as { reverseWindows?: number } | undefined;
      const max = Number(required.params.max_reverse_windows ?? 1);
      results.push(assertion("fade_trend", trend !== undefined && Number(trend.reverseWindows) <= max, trend?.reverseWindows, `<= ${max}`));
    } else if (required.name === "fade_duration_ms") {
      const trend = afterAudio?.fadeTrend as { monotonicWindows?: number; windowMs?: number } | undefined;
      const value = trend?.monotonicWindows !== undefined && trend.windowMs !== undefined ? (Number(trend.monotonicWindows) + 1) * Number(trend.windowMs) : undefined;
      const target = Number(required.params.target);
      const tolerance = Number(required.params.tolerance ?? 120);
      results.push(value === undefined ? analysisAssertion("fade_duration_ms", trend, target, tolerance) : assertion("fade_duration_ms", Math.abs(value - target) <= tolerance, value, target, "MEDIA_ASSERTION_FAILED", tolerance));
    } else if (required.name === "fade_outside_300ms_delta_db") {
      const before = finiteNumber(beforeSegments?.fade_guard);
      const after = finiteNumber(afterSegments?.fade_guard);
      const value = before === undefined || after === undefined ? undefined : before - after;
      const max = Number(required.params.max_delta ?? 2);
      results.push(value === undefined ? analysisAssertion("fade_outside_300ms_delta_db", { before, after }, `<= ${max} dB`) : assertion("fade_outside_300ms_delta_db", value <= max, value, `<= ${max} dB`));
    } else if (required.name === "noise_floor_reduced_db") {
      const value = delta(Number(beforeSegments?.noise), Number(afterSegments?.noise));
      const min = Number(required.params.min ?? 3);
      const max = Number(required.params.max ?? 12);
      results.push(value === undefined || !Number.isFinite(value) ? analysisAssertion("noise_floor_reduced_db", value, `${min}..${max} dB`) : assertion("noise_floor_reduced_db", value >= min && value <= max, value, `${min}..${max} dB`));
    } else if (required.name === "speech_rms_preserved") {
      const value = Math.abs(delta(Number(beforeSegments?.speech), Number(afterSegments?.speech)) ?? 999);
      const max = Number(required.params.max_delta ?? 2);
      results.push(!Number.isFinite(value) || value === 999 ? analysisAssertion("speech_rms_preserved", value, `<= ${max} dB`) : assertion("speech_rms_preserved", value <= max, value, `<= ${max} dB`));
    } else if (required.name === "video_brightened") {
      const beforeFrames = beforeVideo?.sampledFrames as Array<Record<string, number>> | undefined;
      const afterFrames = afterVideo?.sampledFrames as Array<Record<string, number>> | undefined;
      const value = beforeFrames && afterFrames ? (average(afterFrames, "meanY") - average(beforeFrames, "meanY")) / Math.max(1, average(beforeFrames, "meanY")) : undefined;
      results.push(assertion("video_brightened", value !== undefined && value >= 0.03 && value <= 0.35, value, "3%-35%"));
    } else if (required.name === "video_saturation_increased") {
      const beforeFrames = beforeVideo?.sampledFrames as Array<Record<string, number>> | undefined;
      const afterFrames = afterVideo?.sampledFrames as Array<Record<string, number>> | undefined;
      const value = beforeFrames && afterFrames ? (average(afterFrames, "meanSaturation") - average(beforeFrames, "meanSaturation")) / Math.max(0.01, average(beforeFrames, "meanSaturation")) : undefined;
      results.push(assertion("video_saturation_increased", value !== undefined && value >= 0.0005 && value <= 0.40, value, "0.05%-40%"));
    } else if (required.name === "unsupported_mixed_track") {
      results.push(assertion("unsupported_mixed_track", true, "partial", "partial"));
    } else {
      results.push(assertion(required.name, false, "unmapped assertion", required.name, "MEDIA_ANALYSIS_UNAVAILABLE"));
    }
  }
  return results;
};

const renderThroughProductPath = async (testCase: P5PromptCase, project: Project, assets: MediaAsset[], plan: EditPlanResponse, outputPath: string) => {
  const selectedOperations = operationsForProductRender(testCase, plan.operations);
  dryRunEditPlan(project.timeline, selectedOperations);
  const applied = applyEditOperations(project.timeline, selectedOperations, { requestId: plan.request_id, summary: plan.summary });
  process.env.FFMPEG_BIN = process.env.FFMPEG_BIN ?? ffmpegBin();
  process.env.FFPROBE_BIN = process.env.FFPROBE_BIN ?? ffprobeBin();
  const command = buildFfmpegCommand(applied.timeline, "source", resolve(repoRoot, outputPath), assets);
  const execution = await executeExport(command);
  return { appliedOperationIds: applied.appliedOperationIds, selectedOperationIds: selectedOperations.map((operation) => operation.id), execution, timeline: applied.timeline };
};

const timelineForAudioStem = (timeline: Timeline, role: "voice" | "music"): Timeline => {
  const clone = structuredClone(timeline);
  clone.tracks = clone.tracks.filter((track) => track.kind !== "audio" || track.role === role || track.id.includes(role));
  return clone;
};

const renderAudioStemMetrics = async (timeline: Timeline, role: "voice" | "music", assets: MediaAsset[], outputPath: string, testCase: P5PromptCase): Promise<P5AudioMetrics | undefined> => {
  const stemTimeline = timelineForAudioStem(timeline, role);
  if (!stemTimeline.tracks.some((track) => track.kind === "audio" && track.clips.some((clip) => clip.kind === "audio"))) return undefined;
  await mkdir(dirname(resolve(repoRoot, outputPath)), { recursive: true });
  const command = buildFfmpegCommand(stemTimeline, "source", resolve(repoRoot, outputPath), assets);
  const execution = await executeExport(command);
  if (execution.mode !== "ffmpeg") throw new Error(`MEDIA_RENDER_FAILED: ${role} stem render failed`);
  const probe = await ffprobeJson(outputPath);
  return audioStream(probe) ? await analyzeOutputAudio(outputPath, testCase) : undefined;
};

const analyzeDuckStems = async (testCase: P5PromptCase, beforeTimeline: Timeline, afterTimeline: Timeline, assets: MediaAsset[], outputRoot: string): Promise<P5DuckStemMetrics | undefined> => {
  if (!testCase.expectedOperations.includes("duck_music")) return undefined;
  return {
    voice: {
      before: await renderAudioStemMetrics(beforeTimeline, "voice", assets, `${outputRoot}/${testCase.id}/stems/before-voice.mp4`, testCase),
      after: await renderAudioStemMetrics(afterTimeline, "voice", assets, `${outputRoot}/${testCase.id}/stems/after-voice.mp4`, testCase),
    },
    music: {
      before: await renderAudioStemMetrics(beforeTimeline, "music", assets, `${outputRoot}/${testCase.id}/stems/before-music.mp4`, testCase),
      after: await renderAudioStemMetrics(afterTimeline, "music", assets, `${outputRoot}/${testCase.id}/stems/after-music.mp4`, testCase),
    },
  };
};

const runCase = async (testCase: P5PromptCase, fixtureById: Map<string, P5Fixture>, provider: ProviderName, outputRoot: string) => {
  const fixtures = testCase.fixtureIds.map((id) => fixtureById.get(id));
  if (fixtures.some((fixture) => !fixture)) throw new Error(`MEDIA_FIXTURE_MISSING: ${testCase.fixtureIds.join(",")}`);
  const resolvedFixtures = fixtures as P5Fixture[];
  const { project, assets } = await buildProject(testCase, resolvedFixtures, fixtureById);
  const request = requestForCase(testCase, project, assets);
  const inputSha = await sha256(resolvedFixtures[0].path);
  const outputPath = `${outputRoot}/${testCase.id}/output.mp4`;
  const needsVideoMetrics = testCase.assertions.some((item) => item.name.startsWith("video_"));
  const warnings: string[] = [];
  let plan: EditPlanResponse;
  let planAssertions: AssertionResult[];
  try {
    plan = await providerPlan(provider, request);
    planAssertions = validatePlan(testCase, plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      case_id: testCase.id,
      fixture_ids: testCase.fixtureIds,
      prompt: testCase.prompt,
      status: "failed" as RunnerStatus,
      provider_status: "failed" as const,
      operations: [],
      input_sha256: inputSha,
      output_sha256: null,
      output_path: null,
      metrics_before: {},
      metrics_after: {},
      assertions: [assertion("edit_plan_schema_valid", false, message, "valid provider edit plan", "MEDIA_PROVIDER_INVALID_PLAN")],
      failure_code: "MEDIA_PROVIDER_INVALID_PLAN" as P5FailureCode,
      warnings: [message],
    };
  }

  if (testCase.expectedProviderStatus !== "succeeded") {
    const failed = planAssertions.filter((item) => !item.passed);
    return {
      case_id: testCase.id,
      fixture_ids: testCase.fixtureIds,
      prompt: testCase.prompt,
      status: failed.length ? "failed" as RunnerStatus : "passed" as RunnerStatus,
      provider_status: plan.status,
      operations: operationIds(plan.operations),
      input_sha256: inputSha,
      output_sha256: null,
      output_path: null,
      metrics_before: {},
      metrics_after: {},
      assertions: [...planAssertions, assertion("unsupported_mixed_track", plan.status === "partial", plan.status, "partial")],
      failure_code: failed[0]?.failure_code ?? testCase.expectedFailureCode ?? null,
      warnings: [...warnings, ...plan.warnings.map((warning) => `${warning.code}:${warning.message}`)],
    };
  }

  await mkdir(dirname(resolve(repoRoot, outputPath)), { recursive: true });
  const primary = resolvedFixtures[0];
  const beforeAudioFixture = testCase.expectedOperations.includes("duck_music")
    ? resolvedFixtures.find((fixture) => fixture.id.includes("music")) ?? primary
    : primary;
  const beforeProbe = await ffprobeJson(beforeAudioFixture.path);
  const beforeAudio = audioStream(beforeProbe) ? await analyzeAudio(beforeAudioFixture.path, { segments: metricSegments(mediaDurationMs(beforeProbe), testCase) }) : undefined;
  const beforeVideo = needsVideoMetrics && videoStream(beforeProbe) ? await analyzeVideo(primary.path) : undefined;
  try {
    const exported = await renderThroughProductPath(testCase, project, assets, plan, outputPath);
    const outputSha = await sha256(outputPath);
    const outputProbe = await ffprobeJson(outputPath);
    const afterAudio = audioStream(outputProbe) ? await analyzeOutputAudio(outputPath, testCase) : undefined;
    const afterVideo = needsVideoMetrics && videoStream(outputProbe) ? await analyzeVideo(outputPath) : undefined;
    const duckStems = await analyzeDuckStems(testCase, project.timeline, exported.timeline, assets, outputRoot);
    const media = await mediaAssertions(testCase, inputSha, outputSha, beforeAudio, afterAudio, beforeVideo, afterVideo, duckStems);
    const applyAssertions = [
      assertion("dry_run_and_apply_operation_ids_match", exported.appliedOperationIds.length === exported.selectedOperationIds.length, exported.appliedOperationIds, exported.selectedOperationIds, "MEDIA_PROVIDER_INVALID_PLAN"),
      assertion("selected_operation_ids_applied", exported.appliedOperationIds.join(",") === exported.selectedOperationIds.join(","), exported.appliedOperationIds, exported.selectedOperationIds, "MEDIA_PROVIDER_INVALID_PLAN"),
      assertion("export_executor_mode_ffmpeg", exported.execution.mode === "ffmpeg", exported.execution.mode, "ffmpeg", "MEDIA_RENDER_FAILED"),
    ];
    const assertions = [...planAssertions, ...applyAssertions, ...media];
    const failed = assertions.filter((item) => !item.passed);
    return {
      case_id: testCase.id,
      fixture_ids: testCase.fixtureIds,
      prompt: testCase.prompt,
      status: failed.length ? "failed" as RunnerStatus : "passed" as RunnerStatus,
      provider_status: plan.status,
      operations: operationIds(plan.operations),
      input_sha256: inputSha,
      output_sha256: outputSha,
      output_path: rel(resolve(repoRoot, outputPath)),
      metrics_before: { audio: beforeAudio, video: beforeVideo, duck_stems: duckStems ? { voice: duckStems.voice?.before, music: duckStems.music?.before } : undefined },
      metrics_after: { audio: afterAudio, video: afterVideo, duck_stems: duckStems ? { voice: duckStems.voice?.after, music: duckStems.music?.after } : undefined },
      assertions,
      failure_code: failed[0]?.failure_code ?? null,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      case_id: testCase.id,
      fixture_ids: testCase.fixtureIds,
      prompt: testCase.prompt,
      status: "failed" as RunnerStatus,
      provider_status: plan.status,
      operations: operationIds(plan.operations),
      input_sha256: inputSha,
      output_sha256: null,
      output_path: null,
      metrics_before: { audio: beforeAudio, video: beforeVideo },
      metrics_after: {},
      assertions: [...planAssertions, assertion("product_apply_export_rendered", false, message, "successful apply/export", "MEDIA_RENDER_FAILED")],
      failure_code: "MEDIA_RENDER_FAILED" as P5FailureCode,
      warnings: [message],
    };
  }
};

const writeBlockedCodexReport = async (report: string, selectedTotal: number) => {
  const payload: P5Report = {
    schema: "promptcut.p5-real-media-report",
    version: 1,
    run_id: `p5-real-media-${new Date().toISOString()}`,
    provider: "codex-cli",
    summary: { total: selectedTotal, passed: 0, failed: selectedTotal, skipped: 0, hard_failures: selectedTotal },
    environment: {
      ffmpeg_version: await version(ffmpegBin()),
      ffprobe_version: await version(ffprobeBin()),
      node_version: process.version,
      ci: Boolean(process.env.CI),
    },
    cases: [{
      case_id: "codex_cli_unconfigured",
      fixture_ids: [],
      prompt: "Codex CLI provider smoke/full requires CODEX_CLI_BIN or a working codex binary.",
      status: "failed",
      provider_status: "failed",
      operations: [],
      input_sha256: null,
      output_sha256: null,
      output_path: null,
      metrics_before: {},
      metrics_after: {},
      assertions: [assertion("codex_cli_configured", false, process.env.CODEX_CLI_BIN ?? null, "CODEX_CLI_BIN or codex in PATH", "MEDIA_PROVIDER_INVALID_PLAN")],
      failure_code: "MEDIA_PROVIDER_INVALID_PLAN",
      warnings: ["Codex CLI is not configured; this is a blocker, not a skipped success."],
    }],
  };
  await writeJson(report, P5ReportSchema.parse(payload));
  console.log(JSON.stringify(payload.summary, null, 2));
};

const main = async () => {
  const provider = arg("--provider", "mock") as ProviderName;
  const suite = arg("--suite", "smoke");
  const report = arg("--report", provider === "codex-cli" ? "test-results/p5-real-media-codex-report.json" : "test-results/p5-real-media-report.json");
  if (!["mock", "codex-cli"].includes(provider)) throw new Error("--provider must be mock or codex-cli");
  if (!["smoke", "full"].includes(suite)) throw new Error("--suite must be smoke or full");
  if (!existsSync(resolve(repoRoot, "tests/fixtures/media/manifests/p5-real-media-fixtures.json"))) {
    throw new Error("MEDIA_FIXTURE_MISSING: run npm run media:p5:generate-fixtures first");
  }
  const selected = suite === "smoke" ? P5_PROMPT_CASES.filter((item) => P5_SMOKE_CASE_IDS.has(item.id)) : P5_PROMPT_CASES;
  if (provider === "codex-cli" && !process.env.CODEX_CLI_BIN) {
    await writeBlockedCodexReport(report, selected.length);
    process.exit(2);
  }
  const fixtureById = await fixtureMap();
  const outputRoot = `test-results/p5-media/${provider}`;
  const results = [];
  for (const testCase of selected) results.push(await runCase(testCase, fixtureById, provider, outputRoot));
  const failed = results.filter((item) => item.status === "failed");
  const hardFailureCodes: Array<P5FailureCode | null> = ["MEDIA_DECODE_FAILED", "MEDIA_RENDER_FAILED", "MEDIA_OUTPUT_EMPTY", "MEDIA_NO_MEASURABLE_CHANGE", "MEDIA_PROVIDER_INVALID_PLAN"];
  const reportPayload = P5ReportSchema.parse({
    schema: "promptcut.p5-real-media-report",
    version: 1,
    run_id: `p5-real-media-${new Date().toISOString()}`,
    provider,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.status === "passed").length,
      failed: failed.length,
      skipped: results.filter((item) => item.status === "skipped").length,
      hard_failures: failed.filter((item) => hardFailureCodes.includes(item.failure_code)).length,
    },
    environment: {
      ffmpeg_version: await version(ffmpegBin()),
      ffprobe_version: await version(ffprobeBin()),
      node_version: process.version,
      ci: Boolean(process.env.CI),
    },
    cases: results,
  });
  await writeJson(report, reportPayload);
  console.log(JSON.stringify(reportPayload.summary, null, 2));
  if (failed.length > 0 || reportPayload.summary.passed !== reportPayload.summary.total) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
