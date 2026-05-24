import type { Clip, Timeline, Track } from "@/types/editor";
import type { EditOperation } from "@/server/editor/operation-schema";

const findTrack = (timeline: Timeline, trackId: string) => timeline.tracks.find((track) => track.id === trackId);
const findClip = (timeline: Timeline, clipId: string) => timeline.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).find((item) => item.clip.id === clipId);
const ensureRange = (timeline: Timeline, startMs: number, endMs: number) => {
  if (startMs >= endMs) throw new Error("时间范围无效");
  if (startMs < 0 || endMs > timeline.durationMs) throw new Error("操作超出项目时长");
};
const ensureEditable = (track: Track) => {
  if (track.locked) throw new Error(`TRACK_LOCKED:${track.id}`);
};
const ensureAudioClip = (track: Track, clip: Clip) => {
  ensureEditable(track);
  if (track.kind !== "audio" || clip.kind !== "audio") throw new Error("目标不是音频片段");
};
const appendEffect = (clip: Clip, effect: NonNullable<Clip["audioEffects"]>[number]) => {
  clip.audioEffects = [...(clip.audioEffects ?? []), effect];
};
const audioTargets = (timeline: Timeline, target: { clip_id?: string; track_id?: string; start_ms?: number; end_ms?: number }) => {
  if (target.clip_id) {
    const found = findClip(timeline, target.clip_id);
    if (!found) throw new Error(`找不到片段 ${target.clip_id}`);
    ensureAudioClip(found.track, found.clip);
    return [found];
  }
  const tracks = target.track_id ? [findTrack(timeline, target.track_id)].filter(Boolean) as Track[] : timeline.tracks.filter((track) => track.kind === "audio");
  if (tracks.length === 0) throw new Error("NO_AUDIO_TRACK");
  return tracks.flatMap((track) => {
    ensureEditable(track);
    return track.clips.filter((clip) => clip.kind === "audio").map((clip) => ({ track, clip }));
  });
};

export const applyAudioEditOperation = (timeline: Timeline, operation: EditOperation): boolean => {
  switch (operation.type) {
    case "reduce_noise": {
      const targets = audioTargets(timeline, operation.target);
      for (const { clip } of targets) appendEffect(clip, { id: operation.id, type: "reduce_noise", strength: operation.params.strength, preserveVoice: operation.params.preserve_voice, noiseProfile: operation.params.noise_profile, targetNoiseFloorDbfs: operation.params.target_noise_floor_dbfs });
      return true;
    }
    case "equalize_loudness": {
      const targets = audioTargets(timeline, operation.target);
      for (const { clip } of targets) appendEffect(clip, { id: operation.id, type: "equalize_loudness", targetLufs: operation.params.target_lufs, maxGainDb: operation.params.max_gain_db, limitPeakDbfs: operation.params.limit_peak_dbfs, scopeMode: operation.params.scope_mode });
      return true;
    }
    case "duck_music": {
      const musicTrack = findTrack(timeline, operation.target.music_track_id);
      const voiceTrack = findTrack(timeline, operation.target.voice_track_id);
      if (!musicTrack || !voiceTrack) throw new Error("TRACK_ROLE_UNKNOWN");
      ensureEditable(musicTrack);
      ensureEditable(voiceTrack);
      if (musicTrack.kind !== "audio" || voiceTrack.kind !== "audio") throw new Error("目标轨道不是音频轨");
      for (const segment of operation.params.segments) ensureRange(timeline, segment.start_ms, segment.end_ms);
      for (const clip of musicTrack.clips.filter((clip) => clip.kind === "audio")) {
        appendEffect(clip, {
          id: operation.id,
          type: "duck_music",
          voiceTrackId: operation.target.voice_track_id,
          duckDb: operation.params.duck_db,
          attackMs: operation.params.attack_ms,
          releaseMs: operation.params.release_ms,
          segments: operation.params.segments.map((segment) => ({ startMs: segment.start_ms, endMs: segment.end_ms, confidence: segment.confidence })),
        });
      }
      return true;
    }
    case "mute_range": {
      ensureRange(timeline, operation.target.start_ms, operation.target.end_ms);
      for (const { clip } of audioTargets(timeline, operation.target)) {
        appendEffect(clip, { id: operation.id, type: "mute_range", startMs: operation.target.start_ms, endMs: operation.target.end_ms, rampMs: operation.params.ramp_ms, preserveVideo: true });
      }
      return true;
    }
    case "apply_audio_fade": {
      const found = findClip(timeline, operation.target.clip_id);
      if (!found) throw new Error(`找不到片段 ${operation.target.clip_id}`);
      ensureAudioClip(found.track, found.clip);
      const duration = found.clip.endMs - found.clip.startMs;
      if (operation.params.duration_ms > duration / 2) throw new Error("FADE_DURATION_TOO_LONG");
      appendEffect(found.clip, { id: operation.id, type: "audio_fade", fadeType: operation.params.fade_type, durationMs: operation.params.duration_ms, curve: operation.params.curve });
      return true;
    }
    case "shift_audio": {
      for (const { track, clip } of audioTargets(timeline, operation.target)) {
        ensureAudioClip(track, clip);
        if (Math.abs(operation.params.offset_ms) >= timeline.durationMs) throw new Error("操作超出项目时长");
        clip.audioOffsetMs = (clip.audioOffsetMs ?? 0) + operation.params.offset_ms;
      }
      return true;
    }
    case "shift_subtitle_timing": {
      const ids = new Set(operation.target.subtitle_ids ?? []);
      const tracks = operation.target.track_id ? [findTrack(timeline, operation.target.track_id)].filter(Boolean) as Track[] : timeline.tracks.filter((track) => track.kind === "subtitle");
      for (const track of tracks) {
        ensureEditable(track);
        for (const clip of track.clips.filter((clip) => clip.kind === "subtitle" && (ids.size === 0 || ids.has(clip.id)))) {
          const start = clip.startMs + operation.params.offset_ms;
          const end = clip.endMs + operation.params.offset_ms;
          ensureRange(timeline, start, end);
          clip.startMs = start;
          clip.endMs = end;
        }
      }
      return true;
    }
    case "mark_review_range": {
      ensureRange(timeline, operation.target.start_ms, operation.target.end_ms);
      let track = operation.target.track_id ? findTrack(timeline, operation.target.track_id) : timeline.tracks.find((item) => item.id === "ai_markers");
      if (!track) {
        track = { id: "ai_markers", kind: "ai", name: "AI 标记", clips: [] };
        timeline.tracks.push(track);
      }
      ensureEditable(track);
      track.clips.push({ id: `review_${operation.id}`, trackId: track.id, kind: "ai", startMs: operation.target.start_ms, endMs: operation.target.end_ms, sourceStartMs: operation.target.start_ms, sourceEndMs: operation.target.end_ms, text: operation.params.suggested_action, reviewReasonCode: operation.params.reason_code });
      return true;
    }
    default:
      return false;
  }
};
