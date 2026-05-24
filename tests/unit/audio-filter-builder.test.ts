import { describe, expect, it } from "vitest";
import { buildAudioFilterGraph } from "@/server/ffmpeg/audio-filter-builder";
import { buildFfmpegCommand } from "@/server/ffmpeg/command-builder";
import type { MediaAsset, Timeline } from "@/types/editor";

const timeline: Timeline = {
  version: 1,
  durationMs: 60000,
  history: [],
  tracks: [
    { id: "video", kind: "video", name: "视频", clips: [{ id: "video", trackId: "video", kind: "video", assetId: "asset", startMs: 0, endMs: 60000, sourceStartMs: 0, sourceEndMs: 60000 }] },
    {
      id: "audio",
      kind: "audio",
      name: "人声",
      clips: [{
        id: "voice",
        trackId: "audio",
        kind: "audio",
        assetId: "asset",
        startMs: 0,
        endMs: 60000,
        sourceStartMs: 0,
        sourceEndMs: 60000,
        audioOffsetMs: 300,
        audioEffects: [
          { id: "n", type: "reduce_noise", strength: 0.45, preserveVoice: true, noiseProfile: "auto", targetNoiseFloorDbfs: -50 },
          { id: "e", type: "equalize_loudness", targetLufs: -16, maxGainDb: 6, limitPeakDbfs: -1, scopeMode: "track" },
          { id: "d", type: "duck_music", voiceTrackId: "audio", duckDb: -9, attackMs: 120, releaseMs: 650, segments: [{ startMs: 10000, endMs: 45000 }] },
          { id: "m", type: "mute_range", startMs: 3000, endMs: 5000, rampMs: 80, preserveVideo: true },
          { id: "f", type: "audio_fade", fadeType: "out", durationMs: 1200, curve: "equal_power" },
        ],
      }],
    },
  ],
};

const assets: MediaAsset[] = [{ id: "asset", projectId: "project", kind: "video", originalName: "demo.mp4", mimeType: "video/mp4", durationMs: 60000, filePath: "/tmp/demo.mp4" }];

describe("P4 audio filter builder", () => {
  it("maps audio effects to FFmpeg filters", () => {
    const graph = buildAudioFilterGraph(timeline);
    const joined = graph.filters.join(",");
    expect(joined).toContain("afftdn=nr=");
    expect(joined).toContain("loudnorm=I=-16:TP=-1:LRA=11");
    expect(joined).toContain("alimiter=limit=0.8913");
    expect(joined).toContain("between(t,10.000,45.000)");
    expect(joined).toContain("volume=0");
    expect(joined).toContain("afade=t=out");
    expect(joined).toContain("adelay=300|300");
  });

  it("forces re-encode in export command when audio effects are present", () => {
    const command = buildFfmpegCommand(timeline, "source", "out.mp4", assets);
    expect(command.requiresReencode).toBe(true);
    expect(command.args.join(" ")).toContain("-filter_complex");
    expect(command.args.join(" ")).toContain("[aout]");
    expect(command.args.join(" ")).toContain("-c:a aac");
  });
});
