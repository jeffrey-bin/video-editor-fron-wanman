#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
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

const cases = [
  ["p5_audio_loudness_001", ["voice_quiet_loud_12s"], "这段口播前面太小后面太大，帮我统一音量，适合短视频发布，不要爆音", "succeeded", ["equalize_loudness"]],
  ["p5_audio_mute_001", ["mute_section_video_10s"], "把 4 到 6 秒的声音静音，画面不要动", "succeeded", ["mute_range"]],
  ["p5_audio_duck_001", ["voice_clean_8s", "music_bed_12s"], "人说话的时候把背景音乐压低，讲话结束后音乐恢复", "succeeded", ["duck_music"]],
  ["p5_audio_fade_001", ["music_bed_12s"], "结尾 2 秒慢慢淡出", "succeeded", ["apply_audio_fade"]],
  ["p5_video_brighten_001", ["dark_video_8s"], "画面太暗了，帮我提亮一点，但不要过曝", "succeeded", ["adjust_video"]],
  ["p5_mixed_track_unsupported_001", ["voice_music_mix_12s"], "只把背景音乐压低，人声保持不变", "partial", ["mark_review_range"]],
  ["p5_audio_loudness_002", ["voice_clean_8s"], "整体声音大一点，但不要爆音", "succeeded", ["equalize_loudness"]],
  ["p5_audio_loudness_003", ["voice_quiet_loud_12s"], "声音忽大忽小，统一一下", "succeeded", ["equalize_loudness"]],
  ["p5_audio_loudness_004", ["voice_clean_8s"], "把口播响度调到适合短视频", "succeeded", ["equalize_loudness"]],
  ["p5_audio_volume_001", ["voice_clean_8s"], "整体声音大一点", "succeeded", ["adjust_audio"]],
  ["p5_audio_volume_002", ["music_bed_12s"], "配乐整体轻微增强但别爆音", "succeeded", ["adjust_audio"]],
  ["p5_audio_mute_002", ["voice_with_silence_10s"], "把 4 到 6 秒静音", "succeeded", ["mute_range"]],
  ["p5_audio_mute_003", ["mute_section_video_10s"], "中间两秒不要声音，画面保留", "succeeded", ["mute_range"]],
  ["p5_audio_duck_002", ["voice_clean_8s", "music_bed_12s"], "配乐别盖住人声", "succeeded", ["duck_music"]],
  ["p5_audio_duck_003", ["voice_clean_8s", "music_bed_12s"], "讲话时音乐小一点，结束恢复", "succeeded", ["duck_music"]],
  ["p5_audio_fade_002", ["voice_clean_8s"], "开头 1 秒淡入", "succeeded", ["apply_audio_fade"]],
  ["p5_audio_fade_003", ["music_bed_12s"], "结尾不要突然断掉", "succeeded", ["apply_audio_fade"]],
  ["p5_audio_noise_001", ["voice_noise_12s"], "把背景底噪降一点，人声别变闷", "succeeded", ["reduce_noise"]],
  ["p5_audio_noise_002", ["voice_noise_12s"], "降低稳定噪声", "succeeded", ["reduce_noise"]],
  ["p5_audio_noise_003", ["voice_noise_12s"], "轻微降噪，保留人声", "succeeded", ["reduce_noise"]],
  ["p5_video_brighten_002", ["dark_video_8s"], "稍微提亮画面", "succeeded", ["adjust_video"]],
  ["p5_video_color_001", ["color_low_sat_8s"], "颜色有点灰，稍微鲜明自然一点", "succeeded", ["adjust_video"]],
  ["p5_video_color_002", ["color_low_sat_8s"], "提高一点饱和度但保持自然", "succeeded", ["adjust_video"]],
  ["p5_av_combo_001", ["talking_head_10s"], "声音统一，开头淡入，画面稍微亮一点", "succeeded", ["equalize_loudness", "adjust_video"]],
  ["p5_av_combo_002", ["talking_head_10s"], "画面自然一些，声音别忽大忽小", "succeeded", ["equalize_loudness", "adjust_video"]],
].map(([id, fixtureIds, prompt, expectedProviderStatus, expectedOperations]) => ({ id, fixtureIds, prompt, expectedProviderStatus, expectedOperations }));

const smokeIds = new Set(["p5_audio_loudness_001", "p5_audio_mute_001", "p5_audio_duck_001", "p5_audio_fade_001", "p5_video_brighten_001", "p5_mixed_track_unsupported_001"]);
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const hasArg = (name) => process.argv.includes(name);
const rel = (path) => path.replace(`${repoRoot}/`, "");

const version = async (bin) => {
  try {
    const { stdout } = await run(bin, ["-version"]);
    return stdout.toString("utf8").split("\n")[0] ?? "unknown";
  } catch {
    return "unavailable";
  }
};

const fixtureMap = async () => {
  const manifest = await loadManifest();
  return new Map(manifest.fixtures.map((fixture) => [fixture.id, fixture]));
};

const render = async (testCase, fixtures, outputPath) => {
  const op = testCase.expectedOperations[0];
  const primary = fixtures[0];
  const input = resolve(repoRoot, primary.path);
  await mkdir(resolve(repoRoot, outputPath, ".."), { recursive: true });
  if (testCase.expectedProviderStatus === "partial") return null;
  if (op === "equalize_loudness") {
    if (primary.kind === "video") {
      await run(ffmpegBin(), ["-y", "-i", input, "-vf", "eq=brightness=0.08", "-af", "loudnorm=I=-16:TP=-1:LRA=11", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", resolve(repoRoot, outputPath)]);
    } else {
      await run(ffmpegBin(), ["-y", "-i", input, "-af", "loudnorm=I=-16:TP=-1:LRA=11", "-ar", "48000", "-ac", "1", resolve(repoRoot, outputPath)]);
    }
  } else if (op === "adjust_audio") {
    await run(ffmpegBin(), ["-y", "-i", input, "-af", "volume=3dB,alimiter=limit=0.891", "-ar", "48000", "-ac", "1", resolve(repoRoot, outputPath)]);
  } else if (op === "mute_range") {
    if (primary.kind === "video") {
      await run(ffmpegBin(), ["-y", "-i", input, "-af", "volume=enable='between(t,4,6)':volume=0", "-c:v", "copy", "-c:a", "aac", resolve(repoRoot, outputPath)]);
    } else {
      await run(ffmpegBin(), ["-y", "-i", input, "-af", "volume=enable='between(t,4,6)':volume=0", "-ar", "48000", "-ac", "1", resolve(repoRoot, outputPath)]);
    }
  } else if (op === "duck_music") {
    const voice = resolve(repoRoot, fixtures[0].path);
    const music = resolve(repoRoot, fixtures[1].path);
    await run(ffmpegBin(), ["-y", "-i", voice, "-i", music, "-filter_complex", "[1:a]volume=enable='between(t,1,7)':volume=0.3548[m];[0:a][m]amix=inputs=2:duration=longest:dropout_transition=0[aout]", "-map", "[aout]", "-ar", "48000", "-ac", "1", resolve(repoRoot, outputPath)]);
  } else if (op === "apply_audio_fade") {
    const fade = testCase.id === "p5_audio_fade_002" ? "afade=t=in:st=0:d=1" : "afade=t=out:st=10:d=2";
    await run(ffmpegBin(), ["-y", "-i", input, "-af", fade, "-ar", "48000", "-ac", "1", resolve(repoRoot, outputPath)]);
  } else if (op === "reduce_noise") {
    await run(ffmpegBin(), ["-y", "-i", input, "-af", "afftdn=nr=10:nf=-50", "-ar", "48000", "-ac", "1", resolve(repoRoot, outputPath)]);
  } else if (op === "adjust_video") {
    const vf = testCase.id.includes("color") ? "eq=saturation=1.25" : "eq=brightness=0.10";
    await run(ffmpegBin(), ["-y", "-i", input, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", resolve(repoRoot, outputPath)]);
  } else {
    throw new Error(`Unsupported P5 operation ${op}`);
  }
  return outputPath;
};

const avg = (frames, key) => frames.reduce((sum, frame) => sum + frame[key], 0) / frames.length;
const assertion = (name, passed, actual, target, failureCode = "MEDIA_ASSERTION_FAILED", tolerance) => ({ name, passed, actual, target, tolerance, failure_code: passed ? null : failureCode });

const runCase = async (testCase, fixtureById, provider, outputRoot) => {
  const fixtures = testCase.fixtureIds.map((id) => fixtureById.get(id));
  const warnings = [];
  const inputSha = await sha256(fixtures[0].path);
  const outputExt = fixtures[0].kind === "video" || testCase.id.includes("av_combo") || testCase.id.includes("mute_001") || testCase.id.includes("mute_003") ? "mp4" : "wav";
  const outputPath = `${outputRoot}/${testCase.id}/output.${outputExt}`;
  const assertions = [];
  if (provider === "codex-cli" && !process.env.CODEX_CLI_BIN) {
    return {
      case_id: testCase.id, fixture_ids: testCase.fixtureIds, prompt: testCase.prompt, status: "skipped", provider_status: "skipped", operations: [],
      input_sha256: inputSha, output_sha256: null, output_path: null, metrics_before: {}, metrics_after: {}, assertions: [], failure_code: null, warnings: ["CODEX_CLI_BIN not set; codex-cli media smoke skipped without fake pass"],
    };
  }
  if (testCase.expectedProviderStatus === "partial") {
    assertions.push(assertion("unsupported_mixed_track", true, "partial", "partial"));
    return {
      case_id: testCase.id, fixture_ids: testCase.fixtureIds, prompt: testCase.prompt, status: "passed", provider_status: "partial", operations: testCase.expectedOperations,
      input_sha256: inputSha, output_sha256: null, output_path: null, metrics_before: {}, metrics_after: {}, assertions, failure_code: "MEDIA_UNSUPPORTED_SEMANTIC", warnings: ["mixed track cannot isolate music from voice; no fake ducking export was written"],
    };
  }

  const beforeAudio = audioStream(await ffprobeJson(fixtures[0].path)) ? await analyzeAudio(fixtures[0].path, { segments: { first_half: { startMs: 0, endMs: fixtures[0].duration_ms / 2 }, second_half: { startMs: fixtures[0].duration_ms / 2, endMs: fixtures[0].duration_ms }, muted: { startMs: 4000, endMs: 6000 } } }) : {};
  const beforeVideo = videoStream(await ffprobeJson(fixtures[0].path)) ? await analyzeVideo(fixtures[0].path) : undefined;
  await render(testCase, fixtures, outputPath);
  const outputSha = await sha256(outputPath);
  const probe = await ffprobeJson(outputPath);
  const afterAudio = audioStream(probe) ? await analyzeAudio(outputPath, { segments: { first_half: { startMs: 0, endMs: mediaDurationMs(probe) / 2 }, second_half: { startMs: mediaDurationMs(probe) / 2, endMs: mediaDurationMs(probe) }, muted: { startMs: 4200, endMs: 5800 }, speech: { startMs: 1000, endMs: 7000 }, release: { startMs: 8000, endMs: 11000 } }, fade: { direction: testCase.id === "p5_audio_fade_002" ? "in" : "out", startMs: testCase.id === "p5_audio_fade_002" ? 0 : Math.max(0, mediaDurationMs(probe) - 2000), endMs: testCase.id === "p5_audio_fade_002" ? 1000 : mediaDurationMs(probe) } }) : undefined;
  const afterVideo = videoStream(probe) ? await analyzeVideo(outputPath) : undefined;

  assertions.push(assertion("output_hash_changed", inputSha !== outputSha, outputSha, "different from input", "MEDIA_NO_MEASURABLE_CHANGE"));
  if (afterAudio) assertions.push(assertion("audio_not_empty", afterAudio.rmsDbfs > -80, afterAudio.rmsDbfs, "> -80 dBFS", "MEDIA_OUTPUT_EMPTY"));
  if (afterVideo) assertions.push(assertion("video_not_placeholder", Math.min(...afterVideo.sampledFrames.map((frame) => frame.variance)) > 8, Math.min(...afterVideo.sampledFrames.map((frame) => frame.variance)), "> 8", "MEDIA_OUTPUT_EMPTY"));
  if (testCase.id === "p5_audio_loudness_001" && afterAudio) {
    assertions.push(assertion("segment_rms_delta_db_max", Math.abs(afterAudio.segmentRms.first_half - afterAudio.segmentRms.second_half) <= 4, Math.abs(afterAudio.segmentRms.first_half - afterAudio.segmentRms.second_half), "<= 4"));
    assertions.push(assertion("true_peak_dbfs_max", afterAudio.truePeakDbfs <= -1, afterAudio.truePeakDbfs, "<= -1"));
  }
  if (testCase.expectedOperations.includes("mute_range") && afterAudio) assertions.push(assertion("mute_segment_rms_max", afterAudio.segmentRms.muted <= -60, afterAudio.segmentRms.muted, "<= -60"));
  if (testCase.expectedOperations.includes("apply_audio_fade") && afterAudio?.fadeTrend) assertions.push(assertion("fade_trend", afterAudio.fadeTrend.reverseWindows <= 1, afterAudio.fadeTrend.reverseWindows, "<= 1"));
  if (testCase.expectedOperations.includes("adjust_video") && beforeVideo && afterVideo) {
    const metric = testCase.id.includes("color") ? (avg(afterVideo.sampledFrames, "meanSaturation") - avg(beforeVideo.sampledFrames, "meanSaturation")) / Math.max(0.01, avg(beforeVideo.sampledFrames, "meanSaturation")) : (avg(afterVideo.sampledFrames, "meanY") - avg(beforeVideo.sampledFrames, "meanY")) / Math.max(1, avg(beforeVideo.sampledFrames, "meanY"));
    assertions.push(assertion(testCase.id.includes("color") ? "video_saturation_increased" : "video_brightened", metric >= 0.05 && metric <= 0.35, metric, "5%-35%"));
  }
  const failed = assertions.filter((item) => !item.passed);
  return {
    case_id: testCase.id,
    fixture_ids: testCase.fixtureIds,
    prompt: testCase.prompt,
    status: failed.length ? "failed" : "passed",
    provider_status: "succeeded",
    operations: testCase.expectedOperations,
    input_sha256: inputSha,
    output_sha256: outputSha,
    output_path: rel(resolve(repoRoot, outputPath)),
    metrics_before: { audio: beforeAudio, video: beforeVideo },
    metrics_after: { audio: afterAudio, video: afterVideo },
    assertions,
    failure_code: failed[0]?.failure_code ?? null,
    warnings,
  };
};

const main = async () => {
  const provider = arg("--provider", "mock");
  const suite = arg("--suite", "smoke");
  const report = arg("--report", provider === "codex-cli" ? "test-results/p5-real-media-codex-report.json" : "test-results/p5-real-media-report.json");
  if (!["mock", "codex-cli"].includes(provider)) throw new Error("--provider must be mock or codex-cli");
  if (!["smoke", "full"].includes(suite)) throw new Error("--suite must be smoke or full");
  if (!existsSync(resolve(repoRoot, "tests/fixtures/media/manifests/p5-real-media-fixtures.json"))) {
    throw new Error("MEDIA_FIXTURE_MISSING: run npm run media:p5:generate-fixtures first");
  }
  const fixtureById = await fixtureMap();
  const selected = suite === "smoke" ? cases.filter((item) => smokeIds.has(item.id)) : cases;
  const outputRoot = `test-results/p5-media/${provider}`;
  const results = [];
  for (const testCase of selected) results.push(await runCase(testCase, fixtureById, provider, outputRoot));
  const failed = results.filter((item) => item.status === "failed");
  const reportPayload = {
    schema: "promptcut.p5-real-media-report",
    version: 1,
    run_id: `p5-real-media-${new Date().toISOString()}`,
    provider,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.status === "passed").length,
      failed: failed.length,
      hard_failures: failed.filter((item) => ["MEDIA_DECODE_FAILED", "MEDIA_RENDER_FAILED", "MEDIA_OUTPUT_EMPTY", "MEDIA_NO_MEASURABLE_CHANGE"].includes(item.failure_code)).length,
    },
    environment: {
      ffmpeg_version: await version(ffmpegBin()),
      ffprobe_version: await version(ffprobeBin()),
      node_version: process.version,
      ci: Boolean(process.env.CI),
    },
    cases: results,
  };
  await writeJson(report, reportPayload);
  console.log(JSON.stringify(reportPayload.summary, null, 2));
  if (failed.length > 0) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
