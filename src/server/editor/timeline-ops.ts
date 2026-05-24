import type { Clip, Project, Timeline, Track } from "@/types/editor";
import type { EditOperation } from "@/server/editor/operation-schema";

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
  if (existing) return existing;
  const track: Track = { id: requestedId ?? "subtitles", kind: "subtitle", name: "字幕", clips: [] };
  timeline.tracks.push(track);
  return track;
};

const ensureInProjectRange = (timeline: Timeline, startMs: number, endMs: number) => {
  if (startMs >= endMs) throw new Error("时间范围无效");
  if (endMs > timeline.durationMs) throw new Error("操作超出项目时长");
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
        const nextStart = operation.params.timeline_start_ms ?? found.clip.startMs;
        const nextEnd = operation.params.timeline_end_ms ?? found.clip.endMs;
        ensureInProjectRange(timeline, nextStart, nextEnd);
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
        const duration = found.clip.endMs - found.clip.startMs;
        const targetTrack = operation.params.track_id
          ? timeline.tracks.find((track) => track.id === operation.params.track_id)
          : found.track;
        if (!targetTrack) throw new Error("找不到目标轨道");
        found.track.clips.splice(found.index, 1);
        targetTrack.clips.push({ ...found.clip, trackId: targetTrack.id, startMs: operation.params.start_ms, endMs: operation.params.start_ms + duration });
        break;
      }
      case "split_clip": {
        const found = findClip(timeline, operation.target.clip_id);
        if (!found) throw new Error(`找不到片段 ${operation.target.clip_id}`);
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
        });
        break;
      }
      case "update_subtitle": {
        const found = findClip(timeline, operation.target.subtitle_id);
        if (!found || found.clip.kind !== "subtitle") throw new Error("找不到字幕");
        found.clip.text = operation.params.text ?? found.clip.text;
        found.clip.startMs = operation.params.start_ms ?? found.clip.startMs;
        found.clip.endMs = operation.params.end_ms ?? found.clip.endMs;
        ensureInProjectRange(timeline, found.clip.startMs, found.clip.endMs);
        break;
      }
      case "adjust_video": {
        const found = findClip(timeline, operation.target.clip_id);
        if (!found) throw new Error("找不到视频片段");
        found.clip.filters = { ...found.clip.filters, ...operation.params };
        break;
      }
      case "adjust_audio": {
        const found = findClip(timeline, operation.target.clip_id);
        if (!found) throw new Error("找不到音频片段");
        found.clip.volumeDb = operation.params.volume_db ?? found.clip.volumeDb;
        found.clip.muted = operation.params.muted ?? found.clip.muted;
        found.clip.filters = { ...found.clip.filters, normalize: operation.params.normalize ?? found.clip.filters?.normalize };
        break;
      }
      case "set_export_preset":
        warnings.push(`导出预设 ${operation.params.preset} 已记录，将在导出任务中使用`);
        break;
      default:
        throw new Error("不支持的操作");
    }
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
  const subtitles = clips
    .filter((clip) => clip.kind === "subtitle" && clip.text)
    .map((clip) => ({ id: clip.id, start_ms: clip.startMs, end_ms: clip.endMs, text: clip.text ?? "" }));
  return { clips, subtitles };
};
