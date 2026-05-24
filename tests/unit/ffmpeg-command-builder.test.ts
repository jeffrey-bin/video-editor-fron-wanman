import { describe, expect, it } from "vitest";
import { buildFfmpegCommand } from "@/server/ffmpeg/command-builder";
import type { MediaAsset, Timeline } from "@/types/editor";

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

const assets: MediaAsset[] = [
  { id: "asset", projectId: "project", kind: "video", originalName: "demo.mp4", mimeType: "video/mp4", durationMs: 10000, filePath: "/tmp/demo.mp4" },
];

describe("ffmpeg command builder", () => {
  it("builds re-encoded command for filters, subtitles and landscape preset", () => {
    const command = buildFfmpegCommand(timeline, "1080p_landscape", "public/exports/project/out.mp4", assets);
    expect(command.requiresReencode).toBe(true);
    expect(command.args.join(" ")).toContain("-filter_complex");
    expect(command.args.join(" ")).toContain("loudnorm");
    expect(command.args.join(" ")).toContain("libx264");
    expect(command.renderPlan.segments[0].inputPath).toBe("/tmp/demo.mp4");
    expect(command.renderPlan.audioSegments[0].inputPath).toBe("/tmp/demo.mp4");
  });

  it("uses stream copy for simple source preset", () => {
    const simple: Timeline = { ...timeline, tracks: [timeline.tracks[0] ? { ...timeline.tracks[0], clips: [{ ...timeline.tracks[0].clips[0], filters: undefined }] } : timeline.tracks[0]] };
    const command = buildFfmpegCommand(simple, "source", "out.mp4", assets);
    expect(command.requiresReencode).toBe(false);
    expect(command.args).toContain("copy");
  });

  it("adds portrait crop for portrait preset", () => {
    const command = buildFfmpegCommand(timeline, "1080p_portrait", "out.mp4", assets);
    expect(command.args.join(" ")).toContain("crop=1080:1920");
  });

  it("rejects exports that would overwrite a source file", () => {
    expect(() => buildFfmpegCommand(timeline, "source", "/tmp/demo.mp4", assets)).toThrow("导出路径不能覆盖源素材文件");
  });

  it("reports missing audio source files with diagnostic asset context", () => {
    const audioMissing: Timeline = {
      ...timeline,
      tracks: [
        timeline.tracks[0],
        { id: "audio", kind: "audio", name: "音频", clips: [{ id: "audio", trackId: "audio", kind: "audio", assetId: "missing_audio", startMs: 0, endMs: 7000, sourceStartMs: 0, sourceEndMs: 7000 }] },
      ],
    };
    expect(() => buildFfmpegCommand(audioMissing, "source", "out.mp4", [...assets, { id: "missing_audio", projectId: "project", kind: "audio", originalName: "missing.wav", mimeType: "audio/wav", durationMs: 7000 }])).toThrow("音频素材 missing_audio 没有可导出的本地文件");
  });

  it("expresses split/delete/move timelines as multiple render segments", () => {
    const multi: Timeline = {
      ...timeline,
      tracks: [
        {
          id: "video_main",
          kind: "video",
          name: "视频",
          clips: [
            { id: "left", trackId: "video_main", kind: "video", assetId: "asset", startMs: 0, endMs: 2000, sourceStartMs: 0, sourceEndMs: 2000 },
            { id: "right", trackId: "video_main", kind: "video", assetId: "asset", startMs: 2000, endMs: 5000, sourceStartMs: 7000, sourceEndMs: 10000 },
          ],
        },
      ],
    };
    const command = buildFfmpegCommand(multi, "source", "out.mp4", assets);
    expect(command.renderPlan.segments.map((segment) => segment.clipId)).toEqual(["left", "right"]);
    expect(command.args.join(" ")).toContain("concat=n=2:v=1:a=0");
    expect(command.requiresReencode).toBe(true);
  });

  it("builds track-aware audio inputs and mixes independent voice and music assets", () => {
    const multiAudio: Timeline = {
      ...timeline,
      durationMs: 10000,
      tracks: [
        { id: "video_main", kind: "video", name: "视频", clips: [{ id: "clip", trackId: "video_main", kind: "video", assetId: "asset", startMs: 0, endMs: 10000, sourceStartMs: 0, sourceEndMs: 10000 }] },
        {
          id: "voice",
          kind: "audio",
          role: "voice",
          name: "人声",
          clips: [{ id: "voice_clip", trackId: "voice", kind: "audio", assetId: "voice_asset", startMs: 0, endMs: 8000, sourceStartMs: 500, sourceEndMs: 8500, audioEffects: [{ id: "noise", type: "reduce_noise", strength: 0.5, preserveVoice: true, noiseProfile: "auto" }] }],
        },
        {
          id: "music",
          kind: "audio",
          role: "music",
          name: "配乐",
          clips: [{ id: "music_clip", trackId: "music", kind: "audio", assetId: "music_asset", startMs: 1000, endMs: 10000, sourceStartMs: 0, sourceEndMs: 9000, audioEffects: [{ id: "duck", type: "duck_music", voiceTrackId: "voice", duckDb: -9, attackMs: 120, releaseMs: 650, segments: [{ startMs: 2000, endMs: 5000 }] }, { id: "fade", type: "audio_fade", fadeType: "out", durationMs: 1000, curve: "linear" }] }],
        },
      ],
    };
    const command = buildFfmpegCommand(multiAudio, "source", "out.mp4", [
      ...assets,
      { id: "voice_asset", projectId: "project", kind: "audio", originalName: "voice.wav", mimeType: "audio/wav", durationMs: 9000, filePath: "/tmp/voice.wav" },
      { id: "music_asset", projectId: "project", kind: "audio", originalName: "music.mp3", mimeType: "audio/mpeg", durationMs: 9000, filePath: "/tmp/music.mp3" },
    ]);
    const joined = command.args.join(" ");
    expect(command.renderPlan.audioSegments.map((segment) => segment.assetId)).toEqual(["voice_asset", "music_asset"]);
    expect(joined).toContain("-i /tmp/voice.wav -i /tmp/music.mp3");
    expect(joined).toContain("[1:a:0]atrim=start=0.500:end=8.500");
    expect(joined).toContain("[2:a:0]atrim=start=0.000:end=9.000");
    expect(joined).toContain("[a0][a1]amix=inputs=2");
    expect(joined).toContain("[aout]");
    const voiceChain = joined.slice(joined.indexOf("[1:a:0]"), joined.indexOf("[a0]"));
    const musicChain = joined.slice(joined.indexOf("[2:a:0]"), joined.indexOf("[a1]"));
    expect(voiceChain).toContain("afftdn");
    expect(voiceChain).not.toContain("between(t,2.000,5.000)");
    expect(musicChain).toContain("between(t,2.000,5.000)");
    expect(musicChain).toContain("afade=t=out");
  });
});
