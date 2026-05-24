import type { AudioEffect, Clip, Timeline } from "@/types/editor";
import type { RenderPlan, RenderSegment } from "@/server/ffmpeg/timeline-renderer";

export type AudioFilterGraph = {
  filters: string[];
  outputLabel?: string;
  requiresReencode: boolean;
};

const sec = (ms: number) => (ms / 1000).toFixed(3);
const linearFromDb = (db: number) => Number(10 ** (db / 20)).toFixed(4);
const limiterFromDbfs = (dbfs: number) => Number(10 ** (dbfs / 20)).toFixed(4);

const filterForEffect = (effect: AudioEffect, clip: Clip, options: { timelineBased: boolean } = { timelineBased: true }): string[] => {
  switch (effect.type) {
    case "reduce_noise": {
      const nr = Math.min(18, Math.max(4, Math.round(4 + effect.strength * 16)));
      const nf = effect.targetNoiseFloorDbfs ?? -48;
      return [`afftdn=nr=${nr}:nf=${nf}`];
    }
    case "equalize_loudness":
      return [`loudnorm=I=${effect.targetLufs}:TP=${effect.limitPeakDbfs}:LRA=11`, `alimiter=limit=${limiterFromDbfs(effect.limitPeakDbfs)}`];
    case "duck_music":
      return effect.segments.map((segment) => `volume=enable='between(t,${sec(segment.startMs)},${sec(segment.endMs)})':volume=${linearFromDb(effect.duckDb)}`);
    case "mute_range":
      return [`volume=enable='between(t,${sec(effect.startMs)},${sec(effect.endMs)})':volume=0`];
    case "audio_fade": {
      const durationSeconds = sec(effect.durationMs);
      const startMs = options.timelineBased ? (effect.fadeType === "out" ? Math.max(0, clip.endMs - effect.durationMs) : clip.startMs) : (effect.fadeType === "out" ? Math.max(0, clip.endMs - clip.startMs - effect.durationMs) : 0);
      return [`afade=t=${effect.fadeType}:st=${sec(startMs)}:d=${durationSeconds}:curve=${effect.curve === "equal_power" ? "qsin" : "tri"}`];
    }
  }
};

const clipFilters = (clip: Clip, timelineBased: boolean): string[] => {
  const filters: string[] = [];
  if (clip.muted) filters.push("volume=0");
  else if (clip.volumeDb !== undefined) filters.push(`volume=${clip.volumeDb}dB`);
  if (clip.filters?.normalize) filters.push("loudnorm");
  for (const effect of clip.audioEffects ?? []) filters.push(...filterForEffect(effect, clip, { timelineBased }));
  return filters;
};

const findAudioClip = (timeline: Timeline, segment: RenderSegment) =>
  timeline.tracks
    .find((track) => track.id === segment.trackId)
    ?.clips.find((clip) => clip.id === segment.clipId && clip.kind === "audio");

export const buildTrackAwareAudioFilterGraph = (timeline: Timeline, renderPlan: RenderPlan, firstAudioInputIndex: number): AudioFilterGraph => {
  const filters: string[] = [];
  const labels: string[] = [];

  renderPlan.audioSegments.forEach((segment, segmentIndex) => {
    const clip = findAudioClip(timeline, segment);
    if (!clip) throw new Error(`音频片段 ${segment.clipId} 不存在，无法构建导出滤镜`);
    const inputIndex = firstAudioInputIndex + segmentIndex;
    const label = `a${segmentIndex}`;
    const start = sec(segment.sourceStartMs);
    const end = sec(segment.sourceEndMs);
    const delayMs = Math.max(0, segment.timelineStartMs + (segment.audioOffsetMs ?? 0));
    const negativeOffsetTrim = Math.max(0, -(segment.audioOffsetMs ?? 0));
    const chain = [`[${inputIndex}:a:0]atrim=start=${start}:end=${end}`, "asetpts=PTS-STARTPTS"];
    if (negativeOffsetTrim > 0) chain.push(`atrim=start=${sec(negativeOffsetTrim)}`, "asetpts=PTS-STARTPTS");
    chain.push(...clipFilters(clip, false));
    if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`);
    chain.push(`apad=pad_dur=${sec(Math.max(0, renderPlan.durationMs - delayMs))}`, `atrim=duration=${sec(renderPlan.durationMs)}`);
    filters.push(`${chain.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  });

  if (labels.length === 0) return { filters: [], requiresReencode: false };
  if (labels.length === 1) {
    filters.push(`${labels[0]}anull[aout]`);
  } else {
    filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0,aresample=async=1:first_pts=0[aout]`);
  }
  return { filters, outputLabel: "[aout]", requiresReencode: true };
};

export const buildAudioFilterGraph = (timeline: Timeline): AudioFilterGraph => {
  const audioClips = timeline.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === "audio");
  const filters: string[] = [];
  for (const clip of audioClips) {
    filters.push(...clipFilters(clip, true));
    if (clip.audioOffsetMs && clip.audioOffsetMs > 0) filters.push(`adelay=${clip.audioOffsetMs}|${clip.audioOffsetMs}`);
    if (clip.audioOffsetMs && clip.audioOffsetMs < 0) filters.push(`atrim=start=${sec(Math.abs(clip.audioOffsetMs))},asetpts=PTS-STARTPTS`);
  }
  return { filters, requiresReencode: filters.length > 0 };
};
