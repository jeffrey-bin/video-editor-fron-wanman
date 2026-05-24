import { describe, expect, it } from "vitest";
import { buildFfmpegCommand } from "@/server/ffmpeg/command-builder";
import type { Timeline } from "@/types/editor";

const timeline: Timeline = {
  version: 2,
  durationMs: 7000,
  history: [],
  tracks: [
    { id: "video_main", kind: "video", name: "视频", clips: [{ id: "clip", trackId: "video_main", kind: "video", assetId: "asset", startMs: 0, endMs: 7000, sourceStartMs: 3000, sourceEndMs: 10000, filters: { brightness: 0.08, contrast: 0.05, saturation: 0.04 } }] },
    { id: "audio", kind: "audio", name: "音频", clips: [{ id: "audio", trackId: "audio", kind: "audio", assetId: "asset", startMs: 0, endMs: 7000, sourceStartMs: 3000, sourceEndMs: 10000, volumeDb: 2, filters: { normalize: true } }] },
    { id: "subtitles", kind: "subtitle", name: "字幕", clips: [{ id: "sub", trackId: "subtitles", kind: "subtitle", startMs: 1000, endMs: 2000, sourceStartMs: 1000, sourceEndMs: 2000, text: "字幕" }] },
  ],
};

describe("ffmpeg command builder", () => {
  it("builds re-encoded command for filters, subtitles and landscape preset", () => {
    const command = buildFfmpegCommand(timeline, "1080p_landscape", "public/exports/project/out.mp4");
    expect(command.requiresReencode).toBe(true);
    expect(command.args.join(" ")).toContain("-vf");
    expect(command.args.join(" ")).toContain("loudnorm");
    expect(command.args.join(" ")).toContain("libx264");
  });

  it("uses stream copy for simple source preset", () => {
    const simple: Timeline = { ...timeline, tracks: [timeline.tracks[0] ? { ...timeline.tracks[0], clips: [{ ...timeline.tracks[0].clips[0], filters: undefined }] } : timeline.tracks[0]] };
    const command = buildFfmpegCommand(simple, "source", "out.mp4");
    expect(command.requiresReencode).toBe(false);
    expect(command.args).toContain("copy");
  });

  it("adds portrait crop for portrait preset", () => {
    const command = buildFfmpegCommand(timeline, "1080p_portrait", "out.mp4");
    expect(command.args.join(" ")).toContain("crop=1080:1920");
  });
});
