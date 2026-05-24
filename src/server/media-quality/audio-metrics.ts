export type AudioMetrics = {
  durationMs: number;
  integratedLufs?: number;
  truePeakDbfs?: number;
  rmsDbfs: number;
  peakDbfs: number;
  clipSampleRatio: number;
  silenceRanges: Array<{ startMs: number; endMs: number; rmsDbfs: number }>;
  segmentRms: Record<string, number>;
  fadeTrend?: { direction: "in" | "out"; monotonicWindows: number; reverseWindows: number };
  noiseFloorDbfs?: number;
};

export const amplitudeToDbfs = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return -120;
  return 20 * Math.log10(Math.min(1, value));
};

export const rmsDbfs = (samples: ArrayLike<number>) => {
  if (samples.length === 0) return -120;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return amplitudeToDbfs(Math.sqrt(sum / samples.length));
};

export const peakDbfs = (samples: ArrayLike<number>) => {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  return amplitudeToDbfs(peak);
};

export const clipSampleRatio = (samples: ArrayLike<number>, threshold = 0.999) => {
  if (samples.length === 0) return 0;
  let clipped = 0;
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) >= threshold) clipped += 1;
  }
  return clipped / samples.length;
};

export const segmentRmsDbfs = (
  samples: Float32Array,
  sampleRate: number,
  segments: Record<string, { startMs: number; endMs: number }>,
) =>
  Object.fromEntries(
    Object.entries(segments).map(([name, segment]) => {
      const start = Math.max(0, Math.floor((segment.startMs / 1000) * sampleRate));
      const end = Math.min(samples.length, Math.ceil((segment.endMs / 1000) * sampleRate));
      return [name, rmsDbfs(samples.subarray(start, end))];
    }),
  );

export const analyzeSamples = (
  samples: Float32Array,
  sampleRate: number,
  options: {
    durationMs?: number;
    segments?: Record<string, { startMs: number; endMs: number }>;
    fade?: { direction: "in" | "out"; startMs: number; endMs: number; windowMs?: number };
  } = {},
): AudioMetrics => {
  const segmentRms = segmentRmsDbfs(samples, sampleRate, options.segments ?? {});
  const metrics: AudioMetrics = {
    durationMs: options.durationMs ?? Math.round((samples.length / sampleRate) * 1000),
    integratedLufs: rmsDbfs(samples),
    truePeakDbfs: peakDbfs(samples),
    rmsDbfs: rmsDbfs(samples),
    peakDbfs: peakDbfs(samples),
    clipSampleRatio: clipSampleRatio(samples),
    silenceRanges: Object.entries(segmentRms)
      .filter(([, value]) => value <= -60)
      .map(([name, value]) => ({ startMs: options.segments?.[name]?.startMs ?? 0, endMs: options.segments?.[name]?.endMs ?? 0, rmsDbfs: value })),
    segmentRms,
    noiseFloorDbfs: Object.values(segmentRms).length > 0 ? Math.min(...Object.values(segmentRms)) : undefined,
  };
  if (options.fade) metrics.fadeTrend = computeFadeTrend(samples, sampleRate, options.fade);
  return metrics;
};

export const computeFadeTrend = (
  samples: Float32Array,
  sampleRate: number,
  fade: { direction: "in" | "out"; startMs: number; endMs: number; windowMs?: number },
) => {
  const windowMs = fade.windowMs ?? 200;
  const values: number[] = [];
  for (let startMs = fade.startMs; startMs < fade.endMs; startMs += windowMs) {
    const start = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
    const end = Math.min(samples.length, Math.floor((Math.min(fade.endMs, startMs + windowMs) / 1000) * sampleRate));
    values.push(rmsDbfs(samples.subarray(start, end)));
  }
  let monotonicWindows = 0;
  let reverseWindows = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    const expected = fade.direction === "in" ? delta >= -0.75 : delta <= 0.75;
    if (expected) monotonicWindows += 1;
    else reverseWindows += 1;
  }
  return { direction: fade.direction, monotonicWindows, reverseWindows };
};
