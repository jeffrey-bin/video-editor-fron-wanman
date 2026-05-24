import type { AudioEffect, Clip, Timeline } from "@/types/editor";

export type AudioFilterGraph = {
  filters: string[];
  requiresReencode: boolean;
};

const sec = (ms: number) => (ms / 1000).toFixed(3);
const linearFromDb = (db: number) => Number(10 ** (db / 20)).toFixed(4);
const limiterFromDbfs = (dbfs: number) => Number(10 ** (dbfs / 20)).toFixed(4);

const filterForEffect = (effect: AudioEffect, clip: Clip): string[] => {
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
      const startMs = effect.fadeType === "out" ? Math.max(0, clip.endMs - effect.durationMs) : clip.startMs;
      return [`afade=t=${effect.fadeType}:st=${sec(startMs)}:d=${durationSeconds}:curve=${effect.curve === "equal_power" ? "qsin" : "tri"}`];
    }
  }
};

export const buildAudioFilterGraph = (timeline: Timeline): AudioFilterGraph => {
  const audioClips = timeline.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === "audio");
  const filters: string[] = [];
  for (const clip of audioClips) {
    if (clip.muted) filters.push("volume=0");
    else if (clip.volumeDb !== undefined) filters.push(`volume=${clip.volumeDb}dB`);
    if (clip.filters?.normalize) filters.push("loudnorm");
    if (clip.audioOffsetMs && clip.audioOffsetMs > 0) filters.push(`adelay=${clip.audioOffsetMs}|${clip.audioOffsetMs}`);
    if (clip.audioOffsetMs && clip.audioOffsetMs < 0) filters.push(`atrim=start=${sec(Math.abs(clip.audioOffsetMs))},asetpts=PTS-STARTPTS`);
    for (const effect of clip.audioEffects ?? []) filters.push(...filterForEffect(effect, clip));
  }
  return { filters, requiresReencode: filters.length > 0 };
};
