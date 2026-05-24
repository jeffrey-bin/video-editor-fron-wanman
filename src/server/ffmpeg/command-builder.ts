import type { ExportPreset, Timeline } from "@/types/editor";

export type FfmpegCommand = {
  bin: "ffmpeg";
  args: string[];
  outputPath: string;
  requiresReencode: boolean;
};

export const buildFfmpegCommand = (timeline: Timeline, preset: ExportPreset, outputPath: string): FfmpegCommand => {
  const clips = timeline.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind !== "ai");
  const firstAssetClip = clips.find((clip) => clip.assetId);
  const inputPath = firstAssetClip?.assetId ? `public/media/${firstAssetClip.assetId}/original.mp4` : "public/media/placeholder/original.mp4";
  const hasSubtitles = clips.some((clip) => clip.kind === "subtitle" && clip.text);
  const hasVideoFilters = clips.some((clip) => clip.filters?.brightness || clip.filters?.contrast || clip.filters?.saturation);
  const hasAudioFilters = clips.some((clip) => clip.filters?.normalize || clip.volumeDb !== undefined || clip.muted);
  const requiresReencode = hasSubtitles || hasVideoFilters || hasAudioFilters || preset !== "source";
  const args = ["-y", "-i", inputPath];

  if (firstAssetClip) {
    args.push("-ss", (firstAssetClip.sourceStartMs / 1000).toFixed(3), "-t", ((firstAssetClip.sourceEndMs - firstAssetClip.sourceStartMs) / 1000).toFixed(3));
  }

  const videoFilters: string[] = [];
  if (preset === "1080p_landscape") videoFilters.push("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
  if (preset === "1080p_portrait") videoFilters.push("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920");
  if (preset === "720p_preview") videoFilters.push("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2");
  const adjusted = clips.find((clip) => clip.filters?.brightness || clip.filters?.contrast || clip.filters?.saturation);
  if (adjusted?.filters) {
    videoFilters.push(`eq=brightness=${adjusted.filters.brightness ?? 0}:contrast=${1 + (adjusted.filters.contrast ?? 0)}:saturation=${1 + (adjusted.filters.saturation ?? 0)}`);
  }
  if (hasSubtitles) videoFilters.push("drawtext=text='PromptCut 字幕轨':x=(w-text_w)/2:y=h-120:fontsize=36:fontcolor=white");
  if (videoFilters.length > 0) args.push("-vf", videoFilters.join(","));

  const audioFilters: string[] = [];
  const audioClip = clips.find((clip) => clip.filters?.normalize || clip.volumeDb !== undefined || clip.muted);
  if (audioClip?.muted) audioFilters.push("volume=0");
  else if (audioClip?.volumeDb !== undefined) audioFilters.push(`volume=${audioClip.volumeDb}dB`);
  if (audioClip?.filters?.normalize) audioFilters.push("loudnorm");
  if (audioFilters.length > 0) args.push("-af", audioFilters.join(","));

  if (requiresReencode) {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-c", "copy");
  }
  args.push("-movflags", "+faststart", outputPath);
  return { bin: "ffmpeg", args, outputPath, requiresReencode };
};
