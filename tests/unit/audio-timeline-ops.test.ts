import { describe, expect, it } from "vitest";
import { applyEditOperations, dryRunEditPlan } from "@/server/editor/timeline-ops";
import type { Timeline } from "@/types/editor";

const timeline = (): Timeline => ({
  version: 1,
  durationMs: 60000,
  history: [],
  tracks: [
    { id: "video_main", kind: "video", name: "视频", clips: [{ id: "video", trackId: "video_main", kind: "video", assetId: "asset", startMs: 0, endMs: 60000, sourceStartMs: 0, sourceEndMs: 60000 }] },
    { id: "audio_main", kind: "audio", name: "人声", role: "voice", clips: [{ id: "voice", trackId: "audio_main", kind: "audio", assetId: "asset", startMs: 0, endMs: 60000, sourceStartMs: 0, sourceEndMs: 60000 }] },
    { id: "music", kind: "audio", name: "配乐", role: "music", clips: [{ id: "music", trackId: "music", kind: "audio", assetId: "asset", startMs: 0, endMs: 60000, sourceStartMs: 0, sourceEndMs: 60000 }] },
    { id: "subtitles", kind: "subtitle", name: "字幕", clips: [{ id: "sub", trackId: "subtitles", kind: "subtitle", startMs: 1000, endMs: 3000, sourceStartMs: 1000, sourceEndMs: 3000, text: "旧" }] },
  ],
});

describe("P4 audio timeline ops", () => {
  it("applies non-destructive audio effects and keeps video duration", () => {
    const result = applyEditOperations(timeline(), [
      { id: "noise", type: "reduce_noise", target: { clip_id: "voice" }, params: { strength: 0.45, noise_profile: "auto", preserve_voice: true }, rationale: "降噪" },
      { id: "eq", type: "equalize_loudness", target: { track_id: "audio_main" }, params: { target_lufs: -16, max_gain_db: 6, limit_peak_dbfs: -1, scope_mode: "track" }, rationale: "响度" },
      { id: "duck", type: "duck_music", target: { voice_track_id: "audio_main", music_track_id: "music" }, params: { duck_db: -9, attack_ms: 120, release_ms: 650, segments: [{ start_ms: 10000, end_ms: 45000, confidence: 0.91 }] }, rationale: "duck" },
      { id: "mute", type: "mute_range", target: { track_id: "audio_main", start_ms: 3000, end_ms: 5000 }, params: { ramp_ms: 80, preserve_video: true }, rationale: "静音" },
    ], { requestId: "req", summary: "audio" });
    expect(result.timeline.durationMs).toBe(60000);
    expect(result.timeline.tracks[1].clips[0].audioEffects?.map((effect) => effect.type)).toEqual(["reduce_noise", "equalize_loudness", "mute_range"]);
    expect(result.timeline.tracks[2].clips[0].audioEffects?.[0]).toMatchObject({ type: "duck_music", voiceTrackId: "audio_main", duckDb: -9 });
  });

  it("rejects locked tracks, too-long fade and unsafe shifts", () => {
    const locked = timeline();
    locked.tracks[1].locked = true;
    expect(() => dryRunEditPlan(locked, [{ id: "noise", type: "reduce_noise", target: { track_id: "audio_main" }, params: { strength: 0.45, noise_profile: "auto", preserve_voice: true }, rationale: "locked" }])).toThrow("TRACK_LOCKED");
    expect(() => dryRunEditPlan(timeline(), [{ id: "fade", type: "apply_audio_fade", target: { clip_id: "voice" }, params: { fade_type: "out", duration_ms: 40000, curve: "linear" }, rationale: "fade" }])).toThrow("FADE_DURATION_TOO_LONG");
    const shifted = dryRunEditPlan(timeline(), [{ id: "shift", type: "shift_audio", target: { clip_id: "voice" }, params: { offset_ms: -1000, fill_gap: "trim", affects_linked_video: false }, rationale: "shift" }]);
    expect(shifted.timeline.tracks[1].clips[0]).toMatchObject({ startMs: 0, endMs: 60000, audioOffsetMs: -1000 });
  });

  it("shifts subtitles and adds review markers", () => {
    const result = applyEditOperations(timeline(), [
      { id: "subshift", type: "shift_subtitle_timing", target: { subtitle_ids: ["sub"] }, params: { offset_ms: 300 }, rationale: "字幕同步" },
      { id: "review", type: "mark_review_range", target: { start_ms: 5000, end_ms: 7000 }, params: { reason_code: "AUDIO_REVIEW", suggested_action: "人工试听" }, rationale: "标记" },
    ], { requestId: "req", summary: "review" });
    expect(result.timeline.tracks[3].clips[0].startMs).toBe(1300);
    expect(result.timeline.tracks.find((track) => track.id === "ai_markers")?.clips[0].reviewReasonCode).toBe("AUDIO_REVIEW");
  });
});
