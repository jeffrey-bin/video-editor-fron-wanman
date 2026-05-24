import type { P5PromptCase } from "@/server/media-quality/p5-schemas";

const a = (name: string, params: Record<string, unknown> = {}) => ({ name, params });

const assertionsForOperation = (caseId: string, operation: string) => {
  const base = [a("output_hash_changed")];
  if (operation === "equalize_loudness") {
    return [...base, a("audio_not_empty"), a("integrated_lufs", { target: -16, tolerance: 1.5 }), a("true_peak_dbfs_max", { max: -1 })];
  }
  if (operation === "adjust_audio") return [...base, a("audio_not_empty"), a("true_peak_dbfs_max", { max: -1 })];
  if (operation === "mute_range") return [...base, a("audio_not_empty"), a("mute_segment_rms_max", { segment: "muted", max: -60 }), a("mute_boundaries_preserved"), a("mute_boundary_jump_db", { max: 3 })];
  if (operation === "duck_music") {
    return [
      ...base,
      a("audio_not_empty"),
      a("duck_music_delta_db", { min: 6, max: 14, target: 9, tolerance: 2 }),
      a("duck_release_baseline_delta_db", { max_delta: 2 }),
      a("duck_voice_rms_delta_db", { max_delta: 1.5 }),
    ];
  }
  if (operation === "apply_audio_fade") {
    return [
      ...base,
      a("audio_not_empty"),
      a("fade_trend", { max_reverse_windows: 1 }),
      a("fade_duration_ms", { target: caseId === "p5_audio_fade_002" ? 1000 : 1200, tolerance: 120 }),
      a("fade_outside_300ms_delta_db", { max_delta: 2 }),
    ];
  }
  if (operation === "reduce_noise") return [...base, a("audio_not_empty"), a("noise_floor_reduced_db", { min: 3, max: 12 }), a("speech_rms_preserved", { max_delta: 2 })];
  if (operation === "adjust_video") return [...base, a("video_not_placeholder"), caseId.includes("color") ? a("video_saturation_increased") : a("video_brightened")];
  return base;
};

export const P5_PROMPT_CASES: P5PromptCase[] = [
  {
    id: "p5_audio_loudness_001",
    fixtureIds: ["voice_quiet_loud_12s"],
    provider: "both",
    prompt: "这段口播前面太小后面太大，帮我统一音量，适合短视频发布，不要爆音",
    scope: { mode: "timeline" },
    expectedProviderStatus: "succeeded",
    expectedOperations: ["equalize_loudness"],
    assertions: [a("integrated_lufs", { target: -16, tolerance: 1.5 }), a("true_peak_dbfs_max", { max: -1 }), a("segment_rms_delta_db_max", { max: 4 })],
  },
  {
    id: "p5_audio_mute_001",
    fixtureIds: ["mute_section_video_10s"],
    provider: "both",
    prompt: "把 4 到 6 秒的声音静音，画面不要动",
    scope: { mode: "timeline", startMs: 4000, endMs: 6000 },
    expectedProviderStatus: "succeeded",
    expectedOperations: ["mute_range"],
    assertions: [a("mute_segment_rms_max", { segment: "muted", max: -60 }), a("mute_boundaries_preserved"), a("mute_boundary_jump_db", { max: 3 }), a("video_not_placeholder")],
  },
  {
    id: "p5_audio_duck_001",
    fixtureIds: ["voice_clean_8s", "music_bed_12s"],
    provider: "both",
    prompt: "人说话的时候把背景音乐压低，讲话结束后音乐恢复",
    scope: { mode: "timeline" },
    expectedProviderStatus: "succeeded",
    expectedOperations: ["duck_music"],
    assertions: [
      a("output_hash_changed"),
      a("duck_music_delta_db", { min: 6, max: 14, target: 9, tolerance: 2 }),
      a("duck_release_baseline_delta_db", { max_delta: 2 }),
      a("duck_voice_rms_delta_db", { max_delta: 1.5 }),
      a("audio_not_empty"),
    ],
  },
  {
    id: "p5_audio_fade_001",
    fixtureIds: ["music_bed_12s"],
    provider: "both",
    prompt: "结尾 2 秒慢慢淡出",
    scope: { mode: "timeline" },
    expectedProviderStatus: "succeeded",
    expectedOperations: ["apply_audio_fade"],
    assertions: [a("output_hash_changed"), a("audio_not_empty"), a("fade_trend", { max_reverse_windows: 1 }), a("fade_duration_ms", { target: 1200, tolerance: 120 }), a("fade_outside_300ms_delta_db", { max_delta: 2 })],
  },
  {
    id: "p5_video_brighten_001",
    fixtureIds: ["dark_video_8s"],
    provider: "both",
    prompt: "画面太暗了，帮我提亮一点，但不要过曝",
    scope: { mode: "timeline" },
    expectedProviderStatus: "succeeded",
    expectedOperations: ["adjust_video"],
    assertions: [a("video_brightened"), a("video_not_placeholder"), a("output_hash_changed")],
  },
  {
    id: "p5_mixed_track_unsupported_001",
    fixtureIds: ["voice_music_mix_12s"],
    provider: "both",
    prompt: "只把背景音乐压低，人声保持不变",
    scope: { mode: "timeline" },
    expectedProviderStatus: "partial",
    expectedOperations: ["mark_review_range"],
    assertions: [a("unsupported_mixed_track")],
    expectedFailureCode: "MEDIA_UNSUPPORTED_SEMANTIC",
  },
  ...[
    ["p5_audio_loudness_002", "voice_clean_8s", "整体声音大一点，但不要爆音", "equalize_loudness"],
    ["p5_audio_loudness_003", "voice_quiet_loud_12s", "声音忽大忽小，统一一下", "equalize_loudness"],
    ["p5_audio_loudness_004", "voice_clean_8s", "把口播响度调到适合短视频", "equalize_loudness"],
    ["p5_audio_volume_001", "voice_clean_8s", "整体声音大一点", "adjust_audio"],
    ["p5_audio_volume_002", "music_bed_12s", "配乐整体轻微增强但别爆音", "adjust_audio"],
    ["p5_audio_mute_002", "voice_with_silence_10s", "把 4 到 6 秒静音", "mute_range"],
    ["p5_audio_mute_003", "mute_section_video_10s", "把 4 到 6 秒不要声音，画面保留", "mute_range"],
    ["p5_audio_duck_002", "music_bed_12s", "配乐别盖住人声", "duck_music"],
    ["p5_audio_duck_003", "music_bed_12s", "讲话时音乐小一点，结束恢复", "duck_music"],
    ["p5_audio_fade_002", "voice_clean_8s", "开头 1 秒淡入", "apply_audio_fade"],
    ["p5_audio_fade_003", "music_bed_12s", "结尾不要突然断掉", "apply_audio_fade"],
    ["p5_audio_noise_001", "voice_noise_12s", "把背景底噪降一点，人声别变闷", "reduce_noise"],
    ["p5_audio_noise_002", "voice_noise_12s", "降低稳定噪声", "reduce_noise"],
    ["p5_audio_noise_003", "voice_noise_12s", "轻微降噪，保留人声", "reduce_noise"],
    ["p5_video_brighten_002", "dark_video_8s", "稍微提亮画面", "adjust_video"],
    ["p5_video_color_001", "color_low_sat_8s", "颜色有点灰，稍微鲜明自然一点", "adjust_video"],
    ["p5_video_color_002", "color_low_sat_8s", "提高一点饱和度但保持自然", "adjust_video"],
    ["p5_av_combo_001", "talking_head_10s", "声音统一，开头淡入，画面稍微亮一点", "equalize_loudness"],
    ["p5_av_combo_002", "talking_head_10s", "画面自然一些，声音别忽大忽小", "equalize_loudness"],
  ].map(([id, fixtureId, prompt, operation]) => ({
    id,
    fixtureIds: fixtureId === "music_bed_12s" && id.includes("duck") ? ["voice_clean_8s", "music_bed_12s"] : [fixtureId],
    provider: "both" as const,
    prompt,
    scope: { mode: "timeline" as const },
    expectedProviderStatus: "succeeded" as const,
    expectedOperations: [operation],
    assertions: [
      ...assertionsForOperation(id, operation),
      ...(id === "p5_av_combo_001" ? [a("fade_trend", { max_reverse_windows: 1 }), a("video_brightened")] : []),
      ...(id === "p5_av_combo_002" ? [a("video_saturation_increased")] : []),
    ],
  })),
];

export const P5_SMOKE_CASE_IDS = new Set([
  "p5_audio_loudness_001",
  "p5_audio_mute_001",
  "p5_audio_duck_001",
  "p5_audio_fade_001",
  "p5_video_brighten_001",
  "p5_mixed_track_unsupported_001",
]);
