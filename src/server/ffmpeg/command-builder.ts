import type { ExportPreset, MediaAsset, Timeline } from "@/types/editor";
import { buildRenderPlan, type RenderPlan } from "@/server/ffmpeg/timeline-renderer";
import { buildTrackAwareAudioFilterGraph } from "@/server/ffmpeg/audio-filter-builder";
import { resolve } from "node:path";

export type FfmpegCommand = {
  bin: string;
  ffprobeBin: string;
  args: string[];
  outputPath: string;
  requiresReencode: boolean;
  renderPlan: RenderPlan;
};

export const buildFfmpegCommand = (timeline: Timeline, preset: ExportPreset, outputPath: string, mediaAssets: MediaAsset[] = []): FfmpegCommand => {
  const renderPlan = buildRenderPlan(timeline, mediaAssets);
  if (renderPlan.segments.length === 0) throw new Error("时间线没有可导出的视频片段");
  const outputResolved = resolve(outputPath);
  const sourcePaths = [...renderPlan.segments, ...renderPlan.audioSegments].map((segment) => resolve(segment.inputPath));
  if (sourcePaths.includes(outputResolved)) throw new Error("导出路径不能覆盖源素材文件");
  const hasSubtitles = renderPlan.subtitles.length > 0;
  const audioGraph = buildTrackAwareAudioFilterGraph(timeline, renderPlan, renderPlan.segments.length);
  const requiresReencode = hasSubtitles || renderPlan.hasVideoFilters || renderPlan.hasAudioFilters || audioGraph.requiresReencode || preset !== "source" || renderPlan.segments.length > 1;
  const args = ["-y"];

  for (const segment of renderPlan.segments) {
    args.push("-ss", (segment.sourceStartMs / 1000).toFixed(3), "-t", ((segment.sourceEndMs - segment.sourceStartMs) / 1000).toFixed(3), "-i", segment.inputPath);
  }
  for (const segment of renderPlan.audioSegments) {
    args.push("-i", segment.inputPath);
  }

  const videoFilters: string[] = [];
  if (preset === "1080p_landscape") videoFilters.push("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
  if (preset === "1080p_portrait") videoFilters.push("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920");
  if (preset === "720p_preview") videoFilters.push("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2");
  const clips = timeline.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind !== "ai");
  const adjusted = clips.find((clip) => clip.kind === "video" && (clip.filters?.brightness || clip.filters?.contrast || clip.filters?.saturation));
  if (adjusted?.filters) {
    videoFilters.push(`eq=brightness=${adjusted.filters.brightness ?? 0}:contrast=${1 + (adjusted.filters.contrast ?? 0)}:saturation=${1 + (adjusted.filters.saturation ?? 0)}`);
  }
  if (hasSubtitles) videoFilters.push("drawtext=text='PromptCut 字幕轨':x=(w-text_w)/2:y=h-120:fontsize=36:fontcolor=white");
  const complexFilters: string[] = [];
  let videoOutputLabel: string | undefined;
  if (renderPlan.segments.length > 1) {
    const concatInputs = renderPlan.segments.map((_segment, index) => `[${index}:v:0]`).join("");
    complexFilters.push(`${concatInputs}concat=n=${renderPlan.segments.length}:v=1:a=0[vcat]`);
    videoOutputLabel = "[vcat]";
  }
  if (videoFilters.length > 0) {
    const sourceLabel = videoOutputLabel ?? "[0:v:0]";
    complexFilters.push(`${sourceLabel}${videoFilters.join(",")}[vout]`);
    videoOutputLabel = "[vout]";
  }
  complexFilters.push(...audioGraph.filters);

  if (complexFilters.length > 0) {
    args.push("-filter_complex", complexFilters.join(";"));
    args.push("-map", videoOutputLabel ?? "0:v:0");
    if (audioGraph.outputLabel) args.push("-map", audioGraph.outputLabel);
    else args.push("-map", "0:a:0?");
  } else if (videoFilters.length > 0) {
    args.push("-vf", videoFilters.join(","));
  }

  if (requiresReencode) {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-c", "copy");
  }
  args.push("-movflags", "+faststart", outputPath);
  return { bin: process.env.FFMPEG_BIN ?? "ffmpeg", ffprobeBin: process.env.FFPROBE_BIN ?? "ffprobe", args, outputPath, requiresReencode, renderPlan };
};
