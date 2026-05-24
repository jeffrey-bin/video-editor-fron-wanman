#!/usr/bin/env node
/* eslint-env node */
/* global console, process */
import { resolve } from "node:path";
import { analyzeAudio, analyzeVideo, audioStream, ensureDir, ffmpegBin, ffprobeJson, manifestPath, repoRoot, run, videoStream, writeJson } from "./p5-media-lib.mjs";

const fixtures = [
  { id: "voice_clean_8s", kind: "audio", path: "tests/fixtures/media/audio/voice_clean_8s.wav", duration_ms: 8000, purpose: ["equalize_loudness", "fade", "duck_voice"], audio: ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8", "-af", "volume=-12dB"] },
  { id: "voice_quiet_loud_12s", kind: "audio", path: "tests/fixtures/media/audio/voice_quiet_loud_12s.wav", duration_ms: 12000, purpose: ["equalize_loudness", "true_peak_limit"], audio: ["-f", "lavfi", "-i", "sine=frequency=430:sample_rate=48000:duration=6", "-f", "lavfi", "-i", "sine=frequency=430:sample_rate=48000:duration=6", "-filter_complex", "[0:a]volume=-26dB[a0];[1:a]volume=-8dB[a1];[a0][a1]concat=n=2:v=0:a=1[aout]", "-map", "[aout]"] },
  { id: "voice_noise_12s", kind: "audio", path: "tests/fixtures/media/audio/voice_noise_12s.wav", duration_ms: 12000, purpose: ["reduce_noise", "noise_floor"], audio: ["-f", "lavfi", "-i", "sine=frequency=510:sample_rate=48000:duration=12", "-f", "lavfi", "-i", "anoisesrc=color=white:sample_rate=48000:duration=12:amplitude=0.035", "-filter_complex", "[0:a]volume=-13dB[v];[1:a]volume=-18dB[n];[v][n]amix=inputs=2:duration=first[aout]", "-map", "[aout]"] },
  { id: "voice_with_silence_10s", kind: "audio", path: "tests/fixtures/media/audio/voice_with_silence_10s.wav", duration_ms: 10000, purpose: ["silence", "mute_range"], audio: ["-f", "lavfi", "-i", "sine=frequency=470:sample_rate=48000:duration=4", "-f", "lavfi", "-i", "aevalsrc=0:s=48000:d=2", "-f", "lavfi", "-i", "sine=frequency=470:sample_rate=48000:duration=4", "-filter_complex", "[0:a]volume=-12dB[a0];[2:a]volume=-12dB[a2];[a0][1:a][a2]concat=n=3:v=0:a=1[aout]", "-map", "[aout]"] },
  { id: "music_bed_12s", kind: "audio", path: "tests/fixtures/media/audio/music_bed_12s.wav", duration_ms: 12000, purpose: ["duck_music", "fade"], audio: ["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=12", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=12", "-filter_complex", "[0:a]volume=-15dB[a0];[1:a]volume=-18dB[a1];[a0][a1]amix=inputs=2:duration=first[aout]", "-map", "[aout]"] },
  { id: "voice_music_mix_12s", kind: "audio", path: "tests/fixtures/media/audio/voice_music_mix_12s.wav", duration_ms: 12000, purpose: ["mixed_track_unsupported"], audio: ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=12", "-filter_complex", "[0:a]volume=-12dB[v];[1:a]volume=-16dB[m];[v][m]amix=inputs=2:duration=first[aout]", "-map", "[aout]"] },
  { id: "talking_head_10s", kind: "video", path: "tests/fixtures/media/video/talking_head_10s.mp4", duration_ms: 10000, purpose: ["av_sync", "video_decode"], videoFilter: "testsrc2=size=320x180:rate=24:duration=10", audioFilter: "sine=frequency=440:sample_rate=48000:duration=10", vf: "eq=brightness=0.02:saturation=1.15" },
  { id: "dark_video_8s", kind: "video", path: "tests/fixtures/media/video/dark_video_8s.mp4", duration_ms: 8000, purpose: ["brightness", "contrast"], videoFilter: "testsrc2=size=320x180:rate=24:duration=8", audioFilter: "sine=frequency=330:sample_rate=48000:duration=8", vf: "eq=brightness=-0.22:saturation=0.95" },
  { id: "color_low_sat_8s", kind: "video", path: "tests/fixtures/media/video/color_low_sat_8s.mp4", duration_ms: 8000, purpose: ["saturation"], videoFilter: "testsrc2=size=320x180:rate=24:duration=8", audioFilter: "sine=frequency=390:sample_rate=48000:duration=8", vf: "eq=saturation=0.35" },
  { id: "mute_section_video_10s", kind: "video", path: "tests/fixtures/media/video/mute_section_video_10s.mp4", duration_ms: 10000, purpose: ["mute_range", "preserve_video"], videoFilter: "testsrc2=size=320x180:rate=24:duration=10", audioFilter: "sine=frequency=510:sample_rate=48000:duration=10", vf: "eq=brightness=0.01:saturation=1.05" },
];

const generateAudio = async (fixture) => {
  await ensureDir(fixture.path);
  await run(ffmpegBin(), ["-y", ...fixture.audio, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", resolve(repoRoot, fixture.path)]);
};

const generateVideo = async (fixture) => {
  await ensureDir(fixture.path);
  await run(ffmpegBin(), [
    "-y",
    "-f", "lavfi", "-i", fixture.videoFilter,
    "-f", "lavfi", "-i", fixture.audioFilter,
    "-vf", fixture.vf,
    "-shortest",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    resolve(repoRoot, fixture.path),
  ]);
};

const main = async () => {
  const manifestFixtures = [];
  for (const fixture of fixtures) {
    if (fixture.kind === "audio") await generateAudio(fixture);
    else await generateVideo(fixture);
    const probe = await ffprobeJson(fixture.path);
    const audio = audioStream(probe);
    const video = videoStream(probe);
    const metrics = fixture.kind === "audio" ? await analyzeAudio(fixture.path, { segments: { first_half: { startMs: 0, endMs: fixture.duration_ms / 2 }, second_half: { startMs: fixture.duration_ms / 2, endMs: fixture.duration_ms } } }) : await analyzeVideo(fixture.path);
    manifestFixtures.push({
      id: fixture.id,
      kind: fixture.kind,
      path: fixture.path,
      duration_ms: fixture.duration_ms,
      sample_rate: audio ? Number(audio.sample_rate) : undefined,
      channels: audio ? Number(audio.channels) : undefined,
      width: video ? Number(video.width) : undefined,
      height: video ? Number(video.height) : undefined,
      frame_rate: video ? 24 : undefined,
      license: "project-generated",
      purpose: fixture.purpose,
      baseline_metrics: fixture.kind === "audio"
        ? { integrated_lufs: metrics.integratedLufs, true_peak_dbfs: metrics.truePeakDbfs, rms_dbfs: metrics.rmsDbfs, segment_rms_dbfs: metrics.segmentRms }
        : { frame_variance_min: Math.min(...metrics.sampledFrames.map((frame) => frame.variance)), mean_y: metrics.sampledFrames.reduce((sum, frame) => sum + frame.meanY, 0) / metrics.sampledFrames.length },
    });
  }
  await writeJson(manifestPath, { version: 1, generated_by: "scripts/generate-p5-media-fixtures.mjs", fixtures: manifestFixtures });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
