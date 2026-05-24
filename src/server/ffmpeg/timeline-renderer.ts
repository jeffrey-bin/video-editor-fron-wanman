import type { MediaAsset, Timeline } from "@/types/editor";

export type RenderSegment = {
  clipId: string;
  trackId: string;
  trackRole?: string;
  assetId: string;
  inputPath: string;
  timelineStartMs: number;
  timelineEndMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  audioOffsetMs?: number;
};

export type RenderPlan = {
  durationMs: number;
  segments: RenderSegment[];
  audioSegments: RenderSegment[];
  subtitles: { text: string; startMs: number; endMs: number }[];
  hasVideoFilters: boolean;
  hasAudioFilters: boolean;
};

export const buildRenderPlan = (timeline: Timeline, assets: MediaAsset[]): RenderPlan => {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const segments = timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) =>
      track.clips
        .filter((clip) => clip.kind === "video" && clip.assetId)
        .map((clip) => {
          const asset = assetById.get(clip.assetId ?? "");
          if (!asset?.filePath) throw new Error(`素材 ${clip.assetId} 没有可导出的本地文件`);
          return {
            clipId: clip.id,
            trackId: track.id,
            trackRole: track.role,
            assetId: clip.assetId ?? "",
            inputPath: asset.filePath,
            timelineStartMs: clip.startMs,
            timelineEndMs: clip.endMs,
            sourceStartMs: clip.sourceStartMs,
            sourceEndMs: clip.sourceEndMs,
          };
        }),
    )
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  const audioSegments = timeline.tracks
    .filter((track) => track.kind === "audio" && !track.muted)
    .flatMap((track) =>
      track.clips
        .filter((clip) => clip.kind === "audio" && clip.assetId)
        .map((clip) => {
          const asset = assetById.get(clip.assetId ?? "");
          if (!asset?.filePath) throw new Error(`音频素材 ${clip.assetId} 没有可导出的本地文件`);
          return {
            clipId: clip.id,
            trackId: track.id,
            trackRole: track.role,
            assetId: clip.assetId ?? "",
            inputPath: asset.filePath,
            timelineStartMs: clip.startMs,
            timelineEndMs: clip.endMs,
            sourceStartMs: clip.sourceStartMs,
            sourceEndMs: clip.sourceEndMs,
            audioOffsetMs: clip.audioOffsetMs,
          };
        }),
    )
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  const subtitles = timeline.tracks
    .filter((track) => track.kind === "subtitle")
    .flatMap((track) =>
      track.clips
        .filter((clip) => clip.kind === "subtitle" && clip.text)
        .map((clip) => ({ text: clip.text ?? "", startMs: clip.startMs, endMs: clip.endMs })),
    );

  return {
    durationMs: timeline.durationMs,
    segments,
    audioSegments,
    subtitles,
    hasVideoFilters: timeline.tracks.some((track) =>
      track.clips.some((clip) => clip.kind === "video" && (clip.filters?.brightness || clip.filters?.contrast || clip.filters?.saturation)),
    ),
    hasAudioFilters: timeline.tracks.some((track) =>
      track.clips.some((clip) => clip.kind === "audio" && (clip.filters?.normalize || clip.volumeDb !== undefined || clip.muted || (clip.audioEffects?.length ?? 0) > 0 || clip.audioOffsetMs)),
    ),
  };
};
