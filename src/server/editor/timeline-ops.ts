import type { Clip, Project, Timeline, Track } from "@/types/editor";
import type { EditOperation } from "@/server/editor/operation-schema";
import { applyAudioEditOperation } from "@/server/editor/audio-timeline-ops";

export type TimelineApplyResult = {
  timeline: Timeline;
  appliedOperationIds: string[];
  warnings: string[];
};

const cloneTimeline = (timeline: Timeline): Timeline => structuredClone(timeline);

const allClips = (timeline: Timeline): Clip[] => timeline.tracks.flatMap((track) => track.clips);

const findClip = (timeline: Timeline, clipId: string): { track: Track; clip: Clip; index: number } | null => {
  for (const track of timeline.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
};

const subtitleTrack = (timeline: Timeline, requestedId?: string): Track => {
  const existing = requestedId
    ? timeline.tracks.find((track) => track.id === requestedId)
    : timeline.tracks.find((track) => track.kind === "subtitle");
  if (existing && existing.kind !== "subtitle") throw new Error("目标轨道不是字幕轨");
  if (existing?.locked) throw new Error("目标轨道已锁定");
  if (existing) return existing;
  const track: Track = { id: requestedId ?? "subtitles", kind: "subtitle", name: "字幕", clips: [] };
  timeline.tracks.push(track);
  return track;
};

const ensureInProjectRange = (timeline: Timeline, startMs: number, endMs: number) => {
  if (startMs >= endMs) throw new Error("时间范围无效");
  if (endMs > timeline.durationMs) throw new Error("操作超出项目时长");
};

const ensureTrackEditable = (track: Track) => {
  if (track.locked) throw new Error(`轨道 ${track.id} 已锁定`);
};

const ensureClipMatchesTrack = (clip: Clip, track: Track) => {
  if (clip.kind !== track.kind) throw new Error(`片段 ${clip.id} 与轨道 ${track.id} 类型不匹配`);
};

const ensureClipKind = (clip: Clip, expected: Clip["kind"], message: string) => {
  if (clip.kind !== expected) throw new Error(message);
};

const ensureNoOverlaps = (timeline: Timeline) => {
  for (const track of timeline.tracks) {
    if (track.kind === "ai") continue;
    const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index - 1].endMs > sorted[index].startMs) {
        throw new Error(`轨道 ${track.id} 存在重叠片段`);
      }
    }
  }
};

const validateTimeline = (timeline: Timeline) => {
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      ensureClipMatchesTrack(clip, track);
      ensureInProjectRange(timeline, clip.startMs, clip.endMs);
      if (clip.sourceStartMs >= clip.sourceEndMs) throw new Error(`片段 ${clip.id} 源时间范围无效`);
    }
  }
  ensureNoOverlaps(timeline);
};

export const dryRunEditPlan = (timeline: Timeline, operations: EditOperation[]): TimelineApplyResult => {
  return applyEditOperations(timeline, operations, {
    requestId: "dry-run",
    summary: "dry run",
    mutateVersion: false,
  });
};

export const applyEditOperations = (
  original: Timeline,
  operations: EditOperation[],
  options: { requestId: string; summary: string; mutateVersion?: boolean },
): TimelineApplyResult => {
  const timeline = cloneTimeline(original);
  const warnings: string[] = [];
  const appliedOperationIds: string[] = [];

  for (const operation of operations) {
    switch (operation.type) {
      case "trim_clip": {
        const found = findClip(timeline, operation.target.clip_id);
        if (!found) throw new Error(`找不到片段 ${operation.target.clip_id}`);
        ensureTrackEditable(found.track);
        const nextStart = operation.params.timeline_start_ms ?? found.clip.startMs;
        const nextEnd = operation.params.timeline_end_ms ?? found.clip.endMs;
        ensureInProjectRange(timeline, nextStart, nextEnd);
        if (
          operation.params.source_start_ms !== undefined &&
          operation.params.source_end_ms !== undefined &&
          operation.params.source_start_ms >= operation.params.source_end_ms
        ) {
          throw new Error("源时间范围无效");
        }
        found.clip.startMs = nextStart;
        found.clip.endMs = nextEnd;
        found.clip.sourceStartMs = operation.params.source_start_ms ?? found.clip.sourceStartMs;
        found.clip.sourceEndMs = operation.params.source_end_ms ?? found.clip.sourceEndMs;
        break;
      }
      case "delete_range": {
        ensureInProjectRange(timeline, operation.target.start_ms, operation.target.end_ms);
        const amount = operation.target.end_ms - operation.target.start_ms;
        const tracks = operation.target.track_id
          ? timeline.tracks.filter((track) => track.id === operation.target.track_id)
          : timeline.tracks.filter((track) => track.kind !== "ai");
        if (tracks.length === 0) throw new Error("找不到要删除的轨道");
        for (const track of tracks) {
          ensureTrackEditable(track);
          track.clips = track.clips.flatMap((clip) => {
            if (clip.endMs <= operation.target.start_ms || clip.startMs >= operation.target.end_ms) {
              if (operation.params.ripple && clip.startMs >= operation.target.end_ms) {
                return [{ ...clip, startMs: clip.startMs - amount, endMs: clip.endMs - amount }];
              }
              return [clip];
            }
            if (clip.startMs < operation.target.start_ms && clip.endMs > operation.target.end_ms) {
              return [
                { ...clip, endMs: operation.target.start_ms, sourceEndMs: clip.sourceStartMs + (operation.target.start_ms - clip.startMs) },
                {
                  ...clip,
                  id: `${clip.id}_after_${operation.id}`,
                  startMs: operation.params.ripple ? operation.target.start_ms : operation.target.end_ms,
                  endMs: operation.params.ripple ? clip.endMs - amount : clip.endMs,
                  sourceStartMs: clip.sourceStartMs + (operation.target.end_ms - clip.startMs),
                },
              ];
            }
            if (clip.startMs < operation.target.start_ms) {
              return [{ ...clip, endMs: operation.target.start_ms }];
            }
            if (clip.endMs > operation.target.end_ms) {
              return [
                {
                  ...clip,
                  startMs: operation.params.ripple ? operation.target.start_ms : operation.target.end_ms,
                  endMs: operation.params.ripple ? clip.endMs - amount : clip.endMs,
                  sourceStartMs: clip.sourceStartMs + (operation.target.end_ms - clip.startMs),
                },
              ];
            }
            return [];
          });
        }
        if (operation.params.ripple) timeline.durationMs = Math.max(0, timeline.durationMs - amount);
        break;
      }
      case "move_clip": {
        const found = findClip(timeline, operation.target.clip_id);
        if (!found) throw new Error(`找不到片段 ${operation.target.clip_id}`);
        ensureTrackEditable(found.track);
        const duration = found.clip.endMs - found.clip.startMs;
        const targetTrack = operation.params.track_id
          ? timeline.tracks.find((track) => track.id === operation.params.track_id)
          : found.track;
        if (!targetTrack) throw new Error("找不到目标轨道");
        ensureTrackEditable(targetTrack);
        if (targetTrack.kind !== found.clip.kind) throw new Error("目标轨道类型与片段类型不匹配");
        ensureInProjectRange(timeline, operation.params.start_ms, operation.params.start_ms + duration);
        found.track.clips.splice(found.index, 1);
        targetTrack.clips.push({ ...found.clip, trackId: targetTrack.id, startMs: operation.params.start_ms, endMs: operation.params.start_ms + duration });
        break;
      }
      case "split_clip": {
        const found = findClip(timeline, operation.target.clip_id);
        if (!found) throw new Error(`找不到片段 ${operation.target.clip_id}`);
        ensureTrackEditable(found.track);
        if (operation.target.at_ms <= found.clip.startMs || operation.target.at_ms >= found.clip.endMs) {
          throw new Error("切点必须在片段内部");
        }
        const offset = operation.target.at_ms - found.clip.startMs;
        const left = { ...found.clip, endMs: operation.target.at_ms, sourceEndMs: found.clip.sourceStartMs + offset };
        const right = {
          ...found.clip,
          id: `${found.clip.id}_split_${operation.id}`,
          startMs: operation.target.at_ms,
          sourceStartMs: found.clip.sourceStartMs + offset,
        };
        found.track.clips.splice(found.index, 1, left, right);
        break;
      }
      case "add_subtitle": {
        ensureInProjectRange(timeline, operation.params.start_ms, operation.params.end_ms);
        const track = subtitleTrack(timeline, operation.target.track_id);
        track.clips.push({
          id: `subtitle_${operation.id}`,
          trackId: track.id,
          kind: "subtitle",
          startMs: operation.params.start_ms,
          endMs: operation.params.end_ms,
          sourceStartMs: operation.params.start_ms,
          sourceEndMs: operation.params.end_ms,
          text: operation.params.text,
          subtitleConfidence: operation.params.confidence,
          subtitleSource: operation.params.source,
        });
        break;
      }
      case "update_subtitle": {
        const found = findClip(timeline, operation.target.subtitle_id);
        if (!found || found.clip.kind !== "subtitle") throw new Error("找不到字幕");
        ensureTrackEditable(found.track);
        found.clip.text = operation.params.text ?? found.clip.text;
        found.clip.startMs = operation.params.start_ms ?? found.clip.startMs;
        found.clip.endMs = operation.params.end_ms ?? found.clip.endMs;
        found.clip.subtitleConfidence = operation.params.confidence ?? found.clip.subtitleConfidence;
        found.clip.subtitleSource = operation.params.source ?? found.clip.subtitleSource;
        ensureInProjectRange(timeline, found.clip.startMs, found.clip.endMs);
        break;
      }
      case "adjust_video": {
        const found = findClip(timeline, operation.target.clip_id);
        if (!found) throw new Error("找不到视频片段");
        ensureTrackEditable(found.track);
        ensureClipKind(found.clip, "video", "找不到视频片段");
        found.clip.filters = { ...found.clip.filters, ...operation.params };
        break;
      }
      case "adjust_audio": {
        const found = findClip(timeline, operation.target.clip_id);
        if (!found) throw new Error("找不到音频片段");
        ensureTrackEditable(found.track);
        ensureClipKind(found.clip, "audio", "找不到音频片段");
        found.clip.volumeDb = operation.params.volume_db ?? found.clip.volumeDb;
        found.clip.muted = operation.params.muted ?? found.clip.muted;
        found.clip.filters = { ...found.clip.filters, normalize: operation.params.normalize ?? found.clip.filters?.normalize };
        break;
      }
      case "set_export_preset":
        warnings.push(`导出预设 ${operation.params.preset} 已记录，将在导出任务中使用`);
        break;
      default:
        if (!applyAudioEditOperation(timeline, operation)) throw new Error("不支持的操作");
    }
    validateTimeline(timeline);
    appliedOperationIds.push(operation.id);
  }

  if (options.mutateVersion !== false && appliedOperationIds.length > 0) {
    timeline.version += 1;
    timeline.history.push({
      id: `history_${timeline.version}`,
      requestId: options.requestId,
      summary: options.summary,
      operationIds: appliedOperationIds,
      createdAt: new Date().toISOString(),
    });
  }
  for (const track of timeline.tracks) track.clips.sort((a, b) => a.startMs - b.startMs);
  return { timeline, appliedOperationIds, warnings };
};

export const collectProjectContext = (project: Project) => {
  const clips = allClips(project.timeline).map((clip) => ({
    id: clip.id,
    trackId: clip.trackId,
    kind: clip.kind,
    startMs: clip.startMs,
    endMs: clip.endMs,
    assetId: clip.assetId,
    text: clip.text,
  }));
  const defaultSpeechEnd = Math.min(45000, project.timeline.durationMs);
  const defaultTranscriptEnd = Math.min(4000, project.timeline.durationMs);
  const audioTracks = project.timeline.tracks
    .filter((track) => track.kind === "audio")
    .map((track) => ({
      track_id: track.id,
      kind: "audio" as const,
      role: track.role ?? (track.id.includes("music") ? "music" as const : track.id.includes("voice") || track.id.includes("audio") ? "voice" as const : "unknown" as const),
      locked: Boolean(track.locked),
      muted: Boolean(track.muted),
      clips: track.clips.map((clip) => clip.id),
    }));
  const analysisTrack = project.timeline.tracks.find((track) => track.kind === "audio" && track.analysis)?.analysis;
  const subtitles = clips
    .filter((clip) => clip.kind === "subtitle" && clip.text)
    .map((clip) => ({ id: clip.id, start_ms: clip.startMs, end_ms: clip.endMs, text: clip.text ?? "" }));
  return {
    clips,
    subtitles,
    audio: {
      tracks: audioTracks,
      analysis: {
        loudness_lufs: analysisTrack?.loudnessLufs ?? -19.5,
        peak_dbfs: analysisTrack?.peakDbfs ?? -2.1,
        noise_floor_dbfs: analysisTrack?.noiseFloorDbfs ?? -48,
        speech_segments: (analysisTrack?.speechSegments ?? [{ startMs: Math.min(10000, Math.max(0, defaultSpeechEnd - 1000)), endMs: defaultSpeechEnd, confidence: 0.9 }]).map((segment) => ({ start_ms: segment.startMs, end_ms: segment.endMs, confidence: segment.confidence })),
        silence_segments: (analysisTrack?.silenceSegments ?? [{ startMs: 0, endMs: 900, confidence: 0.9 }]).map((segment) => ({ start_ms: segment.startMs, end_ms: segment.endMs, confidence: segment.confidence })),
        transcript_segments: (analysisTrack?.transcriptSegments ?? [
          { startMs: 0, endMs: defaultTranscriptEnd, text: "欢迎来到今天的演示", confidence: 0.98, source: "mock" as const },
          { startMs: Math.min(4120, project.timeline.durationMs - 1), endMs: Math.min(8200, project.timeline.durationMs), text: "我们会演示音频编辑", confidence: 0.95, source: "mock" as const },
          { startMs: Math.min(9350, project.timeline.durationMs - 1), endMs: Math.min(12600, project.timeline.durationMs), text: "自动降噪和智能闪避配乐", confidence: 0.72, source: "mock" as const },
        ]).map((segment) => ({ start_ms: segment.startMs, end_ms: segment.endMs, text: segment.text, confidence: segment.confidence, source: segment.source })),
        av_sync_offset_ms: analysisTrack?.avSyncOffsetMs ?? 180,
        analysis_source: analysisTrack?.analysisSource ?? "mock",
      },
    },
  };
};
