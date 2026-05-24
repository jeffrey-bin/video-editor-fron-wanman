import type { P5FailureCode, P5Report } from "@/server/media-quality/p5-schemas";

type AssertionResult = NonNullable<P5Report["cases"][number]["assertions"]>[number];
export type P5AudioMetrics = Record<string, unknown> & { segmentRms?: Record<string, number> };
export type P5DuckStemMetrics = {
  voice?: { before?: P5AudioMetrics; after?: P5AudioMetrics };
  music?: { before?: P5AudioMetrics; after?: P5AudioMetrics };
};

const assertion = (name: string, passed: boolean, actual?: unknown, target?: unknown, failureCode: P5FailureCode = "MEDIA_ASSERTION_FAILED", tolerance?: number): AssertionResult => ({
  name,
  passed,
  actual,
  target,
  tolerance,
  failure_code: passed ? null : failureCode,
});

const finiteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const segmentRms = (metrics: P5AudioMetrics | undefined, segment: string) => finiteNumber(metrics?.segmentRms?.[segment]);
const analysisAssertion = (name: string, actual: unknown, target: unknown, tolerance?: number) =>
  assertion(name, false, actual ?? "missing metric", target, "MEDIA_ANALYSIS_UNAVAILABLE", tolerance);

export const evaluateDuckStemAssertions = (required: { name: string; params: Record<string, unknown> }, duckStems?: P5DuckStemMetrics): AssertionResult | undefined => {
  if (required.name === "duck_music_delta_db") {
    const before = segmentRms(duckStems?.music?.before, "speech");
    const after = segmentRms(duckStems?.music?.after, "speech");
    const value = before === undefined || after === undefined ? undefined : before - after;
    const min = Number(required.params.min ?? 6);
    const max = Number(required.params.max ?? 14);
    const target = finiteNumber(required.params.target);
    const tolerance = finiteNumber(required.params.tolerance);
    const inDefaultBand = target === undefined || tolerance === undefined || (value !== undefined && Math.abs(value - target) <= tolerance);
    return value === undefined
      ? analysisAssertion("duck_music_delta_db", { beforeMusicRms: before, afterMusicRms: after }, `${min}..${max} dB`, tolerance)
      : assertion("duck_music_delta_db", value >= min && value <= max && inDefaultBand, value, `${min}..${max} dB; default ${target}±${tolerance} dB`, "MEDIA_ASSERTION_FAILED", tolerance);
  }
  if (required.name === "duck_release_baseline_delta_db") {
    const before = segmentRms(duckStems?.music?.before, "release");
    const after = segmentRms(duckStems?.music?.after, "release");
    const value = before === undefined || after === undefined ? undefined : Math.abs(before - after);
    const max = Number(required.params.max_delta ?? 2);
    return value === undefined
      ? analysisAssertion("duck_release_baseline_delta_db", { beforeMusicReleaseRms: before, afterMusicReleaseRms: after }, `<= ${max} dB`)
      : assertion("duck_release_baseline_delta_db", value <= max, value, `<= ${max} dB`);
  }
  if (required.name === "duck_voice_rms_delta_db") {
    const before = segmentRms(duckStems?.voice?.before, "speech");
    const after = segmentRms(duckStems?.voice?.after, "speech");
    const value = before === undefined || after === undefined ? undefined : Math.abs(before - after);
    const max = Number(required.params.max_delta ?? 1.5);
    return value === undefined
      ? analysisAssertion("duck_voice_rms_delta_db", { beforeVoiceRms: before, afterVoiceRms: after }, `<= ${max} dB`)
      : assertion("duck_voice_rms_delta_db", value <= max, value, `<= ${max} dB`);
  }
  return undefined;
};
