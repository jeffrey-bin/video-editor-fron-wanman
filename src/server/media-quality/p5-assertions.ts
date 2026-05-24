import type { AudioMetrics } from "@/server/media-quality/audio-metrics";
import { averageFrameMetric, type VideoMetrics } from "@/server/media-quality/video-metrics";
import type { P5FailureCode } from "@/server/media-quality/p5-schemas";

export type P5AssertionResult = {
  name: string;
  passed: boolean;
  actual?: unknown;
  target?: unknown;
  tolerance?: number;
  failure_code?: P5FailureCode | null;
};

export const pass = (name: string, actual?: unknown, target?: unknown, tolerance?: number): P5AssertionResult => ({
  name,
  passed: true,
  actual,
  target,
  tolerance,
  failure_code: null,
});

export const fail = (name: string, actual: unknown, target: unknown, failureCode: P5FailureCode = "MEDIA_ASSERTION_FAILED", tolerance?: number): P5AssertionResult => ({
  name,
  passed: false,
  actual,
  target,
  tolerance,
  failure_code: failureCode,
});

export const assertWithin = (name: string, actual: number | undefined, target: number, tolerance: number) =>
  actual !== undefined && Math.abs(actual - target) <= tolerance ? pass(name, actual, target, tolerance) : fail(name, actual, target, "MEDIA_ASSERTION_FAILED", tolerance);

export const assertAtMost = (name: string, actual: number | undefined, max: number) =>
  actual !== undefined && actual <= max ? pass(name, actual, max) : fail(name, actual, max);

export const assertAtLeast = (name: string, actual: number | undefined, min: number) =>
  actual !== undefined && actual >= min ? pass(name, actual, min) : fail(name, actual, min);

export const assertHashChanged = (inputSha: string, outputSha: string, expectedChange = true) =>
  !expectedChange || inputSha !== outputSha
    ? pass("output_hash_changed", outputSha, "different from input")
    : fail("output_hash_changed", outputSha, "different from input", "MEDIA_NO_MEASURABLE_CHANGE");

export const assertAudioNotEmpty = (metrics: AudioMetrics) =>
  metrics.rmsDbfs > -80 ? pass("audio_not_empty", metrics.rmsDbfs, "> -80 dBFS") : fail("audio_not_empty", metrics.rmsDbfs, "> -80 dBFS", "MEDIA_OUTPUT_EMPTY");

export const assertSegmentDeltaAtMost = (name: string, metrics: AudioMetrics, a: string, b: string, maxDeltaDb: number) => {
  const delta = Math.abs((metrics.segmentRms[a] ?? -120) - (metrics.segmentRms[b] ?? -120));
  return delta <= maxDeltaDb ? pass(name, delta, maxDeltaDb) : fail(name, delta, maxDeltaDb);
};

export const assertSegmentRmsAtMost = (name: string, metrics: AudioMetrics, segment: string, maxDbfs: number) =>
  assertAtMost(name, metrics.segmentRms[segment], maxDbfs);

export const assertFadeTrend = (metrics: AudioMetrics, maxReverseWindows = 1) =>
  metrics.fadeTrend && metrics.fadeTrend.reverseWindows <= maxReverseWindows
    ? pass("fade_trend", metrics.fadeTrend.reverseWindows, maxReverseWindows)
    : fail("fade_trend", metrics.fadeTrend?.reverseWindows, maxReverseWindows);

export const assertVideoNotPlaceholder = (metrics: VideoMetrics, minVariance = 8) => {
  const minFrameVariance = Math.min(...metrics.sampledFrames.map((frame) => frame.variance));
  return minFrameVariance > minVariance ? pass("video_not_placeholder", minFrameVariance, `> ${minVariance}`) : fail("video_not_placeholder", minFrameVariance, `> ${minVariance}`, "MEDIA_OUTPUT_EMPTY");
};

export const assertVideoBrightened = (before: VideoMetrics, after: VideoMetrics, minRatio = 0.05, maxRatio = 0.25) => {
  const beforeMean = averageFrameMetric(before, "meanY");
  const afterMean = averageFrameMetric(after, "meanY");
  const ratio = (afterMean - beforeMean) / Math.max(1, beforeMean);
  return ratio >= minRatio && ratio <= maxRatio ? pass("video_brightened", ratio, `${minRatio}..${maxRatio}`) : fail("video_brightened", ratio, `${minRatio}..${maxRatio}`);
};

export const assertVideoSaturationIncreased = (before: VideoMetrics, after: VideoMetrics, minRatio = 0.05, maxRatio = 0.35) => {
  const beforeMean = averageFrameMetric(before, "meanSaturation");
  const afterMean = averageFrameMetric(after, "meanSaturation");
  const ratio = (afterMean - beforeMean) / Math.max(0.01, beforeMean);
  return ratio >= minRatio && ratio <= maxRatio ? pass("video_saturation_increased", ratio, `${minRatio}..${maxRatio}`) : fail("video_saturation_increased", ratio, `${minRatio}..${maxRatio}`);
};
