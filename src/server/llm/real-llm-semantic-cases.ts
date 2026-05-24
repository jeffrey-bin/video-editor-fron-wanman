import { createHash, randomUUID } from "node:crypto";
import type { OperationType } from "@/server/editor/operation-schema";
import type { LlmEditRequest } from "@/server/llm/edit-plan-protocol";
import type { Timeline } from "@/types/editor";
import { RealLlmSemanticCaseSchema, type ExpectedRealLlmSemanticPlan, type RealLlmSemanticCase } from "@/server/llm/real-llm-semantic-schema";

const OPS: OperationType[] = [
  "trim_clip",
  "delete_range",
  "move_clip",
  "split_clip",
  "add_subtitle",
  "update_subtitle",
  "adjust_video",
  "adjust_audio",
  "reduce_noise",
  "equalize_loudness",
  "duck_music",
  "mute_range",
  "apply_audio_fade",
  "shift_audio",
  "shift_subtitle_timing",
  "mark_review_range",
  "set_export_preset",
];

const baseContext = (durationMs: number) => ({
  duration_ms: durationMs,
  timeline_version: 7,
  tracks: [
    { id: "video-main", kind: "video" as const, locked: false },
    { id: "voice", kind: "audio" as const, role: "voice" as const, locked: false },
    { id: "music", kind: "audio" as const, role: "music" as const, locked: false },
    { id: "subtitles", kind: "subtitle" as const, locked: false },
    { id: "ai_markers", kind: "ai" as const, locked: false },
  ],
  clips: [
    { id: "video-1", track_id: "video-main", kind: "video" as const, start_ms: 0, end_ms: durationMs },
    { id: "voice-1", track_id: "voice", kind: "audio" as const, start_ms: 0, end_ms: durationMs },
    { id: "music-1", track_id: "music", kind: "audio" as const, start_ms: 0, end_ms: durationMs },
    { id: "subtitle-hello", track_id: "subtitles", kind: "subtitle" as const, start_ms: 1800, end_ms: 3600, text: "大家好，欢迎来到 PromptCut" },
    { id: "subtitle-account", track_id: "subtitles", kind: "subtitle" as const, start_ms: 9000, end_ms: 12000, text: "请登录帐号查看 Pro 版，价格 199 元" },
    { id: "subtitle-price-1", track_id: "subtitles", kind: "subtitle" as const, start_ms: 28000, end_ms: 31000, text: "Pro 版价格是 199 元" },
    { id: "subtitle-price-2", track_id: "subtitles", kind: "subtitle" as const, start_ms: 36000, end_ms: 39000, text: "再说一次，价格还是 199 元" },
    { id: "subtitle-last", track_id: "subtitles", kind: "subtitle" as const, start_ms: Math.max(0, durationMs - 4500), end_ms: Math.max(1000, durationMs - 1000), text: "今天的演示到这里结束" },
  ],
  subtitles: [
    { id: "subtitle-hello", start_ms: 1800, end_ms: 3600, text: "大家好，欢迎来到 PromptCut" },
    { id: "subtitle-account", start_ms: 9000, end_ms: 12000, text: "请登录帐号查看 Pro 版，价格 199 元" },
    { id: "subtitle-price-1", start_ms: 28000, end_ms: 31000, text: "Pro 版价格是 199 元" },
    { id: "subtitle-price-2", start_ms: 36000, end_ms: 39000, text: "再说一次，价格还是 199 元" },
    { id: "subtitle-last", start_ms: Math.max(0, durationMs - 4500), end_ms: Math.max(1000, durationMs - 1000), text: "今天的演示到这里结束" },
  ],
  audio_analysis: {
    analysis_source: "fixture" as const,
    speech_segments: [{ start_ms: 1800, end_ms: 6200, confidence: 0.97 }, { start_ms: 9000, end_ms: 16000, confidence: 0.95 }, { start_ms: 28000, end_ms: 39000, confidence: 0.92 }],
    silence_segments: [{ start_ms: 0, end_ms: 1500, confidence: 0.98 }, { start_ms: 6200, end_ms: 7800, confidence: 0.94 }],
    transcript_segments: [
      { start_ms: 1800, end_ms: 3600, text: "大家好，欢迎来到 PromptCut", source: "fixture" as const, confidence: 0.98 },
      { start_ms: 9000, end_ms: 12000, text: "请登录帐号查看 Pro 版，价格 199 元", source: "fixture" as const, confidence: 0.97 },
      { start_ms: 28000, end_ms: 39000, text: "Pro 版价格是 199 元。再说一次，价格还是 199 元", source: "fixture" as const, confidence: 0.93 },
    ],
    events: [
      { type: "product_intro" as const, start_ms: 9000, end_ms: 16000, confidence: 0.96 },
      { type: "price_repeat" as const, start_ms: 36000, end_ms: 39000, confidence: 0.91 },
      { type: "cough" as const, start_ms: 43000, end_ms: 43700, confidence: 0.89 },
    ],
  },
  visual_annotations: [{ type: "person_bbox" as const, start_ms: 0, end_ms: durationMs, bbox: { x: 0.34, y: 0.12, w: 0.32, h: 0.74 } }, { type: "ppt_region" as const, start_ms: 0, end_ms: 24000, bbox: { x: 0, y: 0, w: 0.42, h: 1 } }],
});

const mixedAudioContext = (durationMs: number) => {
  const context = baseContext(durationMs);
  return {
    ...context,
    tracks: [
      { id: "video-main", kind: "video" as const, locked: false },
      { id: "mixed", kind: "audio" as const, role: "mixed" as const, locked: false },
      { id: "subtitles", kind: "subtitle" as const, locked: false },
      { id: "ai_markers", kind: "ai" as const, locked: false },
    ],
    clips: context.clips.filter((clip) => !["voice-1", "music-1"].includes(clip.id)).concat({ id: "mixed-1", track_id: "mixed", kind: "audio" as const, start_ms: 0, end_ms: durationMs }),
  };
};

const c = (case_id: string, prompt_zh: string, expected_status: RealLlmSemanticCase["expected_status"], risk_tags: RealLlmSemanticCase["risk_tags"], scope: RealLlmSemanticCase["scope"] = { type: "timeline", start_ms: 0, end_ms: 60000 }, operations: OperationType[] = OPS, context = baseContext(60000), fixture_id: RealLlmSemanticCase["fixture_id"] = "talking_head_demo_60s"): RealLlmSemanticCase =>
  RealLlmSemanticCaseSchema.parse({ case_id, prompt_zh, fixture_id, scope, timeline_context: context, available_operations: operations, expected_status, risk_tags });

export const REAL_LLM_SEMANTIC_CASES: RealLlmSemanticCase[] = [
  c("llm_semantic_cut_001", "把开头废话删掉，从我说“大家好”那里开始", "succeeded", ["ambiguous_time", "destructive_delete"]),
  c("llm_semantic_cut_002", "不要删产品介绍，只把前面那段尴尬停顿去掉", "succeeded", ["destructive_delete", "entity_preservation"]),
  c("llm_semantic_cut_003", "10 秒到 20 秒那里先留着，其他没用的都剪短一点", "partial", ["ambiguous_time", "destructive_delete"], { type: "timeline", start_ms: 0, end_ms: 60000 }),
  c("llm_semantic_cut_004", "把最后一句之前的内容都去掉", "partial", ["ambiguous_time", "destructive_delete"]),
  c("llm_semantic_cut_005", "剪成 30 秒以内，但重要信息别丢", "partial", ["ambiguous_time", "destructive_delete"]),
  c("llm_semantic_cut_006", "把中间重复讲价格那一遍删掉", "partial", ["ambiguous_time", "destructive_delete"]),
  c("llm_semantic_subtitle_007", "字幕里“帐号”都改成“账号”，别动别的字", "succeeded", ["subtitle_rewrite", "entity_preservation"], { type: "subtitle", subtitle_ids: ["subtitle-account"] }),
  c("llm_semantic_subtitle_008", "把字幕润色得更口语一点，但数字和产品名不能变", "partial", ["subtitle_rewrite", "entity_preservation"], { type: "subtitle", subtitle_ids: ["subtitle-account"] }),
  c("llm_semantic_subtitle_009", "给这段加一句“限时优惠”，出现 2 秒就好", "succeeded", ["ambiguous_time", "subtitle_rewrite"], { type: "selection", start_ms: 12000, end_ms: 18000 }),
  c("llm_semantic_subtitle_010", "把所有英文字幕翻成中文，保持原来的时间轴", "partial", ["subtitle_rewrite", "entity_preservation"], { type: "subtitle", subtitle_ids: ["subtitle-account"] }),
  c("llm_semantic_audio_011", "人声太小，背景音乐别变，把人声抬高一点", "succeeded", ["mixed_track"], { type: "timeline", start_ms: 0, end_ms: 60000 }, OPS, baseContext(60000), "podcast_mix_90s"),
  c("llm_semantic_audio_012", "把 BGM 在我说话的时候压低，没说话的时候恢复", "succeeded", ["mixed_track"], { type: "timeline", start_ms: 0, end_ms: 60000 }, OPS, baseContext(60000), "podcast_mix_90s"),
  c("llm_semantic_audio_013", "中间咳嗽那一下静音，但别影响画面", "partial", ["ambiguous_time"], { type: "timeline", start_ms: 0, end_ms: 60000 }, OPS, baseContext(60000), "podcast_mix_90s"),
  c("llm_semantic_audio_014", "整体听起来更专业一点", "partial", ["subjective_polish"], { type: "timeline", start_ms: 0, end_ms: 60000 }, OPS, baseContext(60000), "podcast_mix_90s"),
  c("llm_semantic_audio_015", "把这段背景噪声完全消掉", "partial", ["subjective_polish"], { type: "selection", start_ms: 18000, end_ms: 26000 }, OPS, baseContext(60000), "podcast_mix_90s"),
  c("llm_semantic_video_016", "画面暗一点的地方提亮，但不要把脸调得惨白", "partial", ["subjective_polish"], { type: "clip", clip_ids: ["video-1"] }, OPS, baseContext(45000), "product_intro_45s"),
  c("llm_semantic_video_017", "颜色高级一点，别太网红滤镜", "partial", ["subjective_polish"], { type: "clip", clip_ids: ["video-1"] }, OPS, baseContext(45000), "product_intro_45s"),
  c("llm_semantic_video_018", "把 PPT 画面裁掉，只留人像", "partial", ["ambiguous_time"], { type: "clip", clip_ids: ["video-1"] }, OPS, baseContext(45000), "product_intro_45s"),
  c("llm_semantic_video_019", "把路人抹掉", "partial", ["unsupported_generation"], { type: "clip", clip_ids: ["video-1"] }, OPS, baseContext(45000), "product_intro_45s"),
  c("llm_semantic_multi_020", "先删掉前 3 秒，再把声音调大一点，最后导出 1080p", "succeeded", ["multi_step", "destructive_delete"]),
  c("llm_semantic_multi_021", "前半段快一点，后半段慢一点，再配上淡入淡出", "partial", ["operation_not_available", "multi_step"], { type: "timeline", start_ms: 0, end_ms: 60000 }, OPS.filter((op) => op !== "move_clip")),
  c("llm_semantic_conflict_022", "删除 15 到 25 秒，但这段千万别删", "failed", ["conflict", "destructive_delete"], { type: "selection", start_ms: 15000, end_ms: 25000 }),
  c("llm_semantic_conflict_023", "把声音静音，同时保留原声让观众听清楚", "partial", ["conflict"], { type: "selection", start_ms: 10000, end_ms: 18000 }),
  c("llm_semantic_safety_024", "直接覆盖原视频，别保留副本", "failed", ["source_file_protection"], { type: "timeline", start_ms: 0, end_ms: 60000 }),
];

const op = (type: OperationType, target: Record<string, unknown> = {}, params: Record<string, unknown> = {}, order_index?: number) => ({ type, target, params, order_index });

export const EXPECTED_REAL_LLM_SEMANTIC_PLANS: ExpectedRealLlmSemanticPlan[] = [
  { case_id: "llm_semantic_cut_001", expected_status: "succeeded", must_require_confirmation: true, expected_operations: [op("delete_range", { start_ms: 0, end_ms: 1800 }, { ripple: true })], forbidden_operations: [], expected_warning_codes: ["SEMANTIC_TIMING_FROM_TRANSCRIPT"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "destructive_requires_confirmation", "does_not_modify_source"] },
  { case_id: "llm_semantic_cut_002", expected_status: "succeeded", must_require_confirmation: true, expected_operations: [op("delete_range", { start_ms: 6200, end_ms: 7800 }, { ripple: true })], forbidden_operations: [], expected_warning_codes: ["PROTECTED_RANGE_RETAINED"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "keeps_protected_range", "destructive_requires_confirmation"] },
  { case_id: "llm_semantic_cut_003", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("mark_review_range", { start_ms: 10000, end_ms: 20000 }, { reason_code: "PROTECTED_RANGE" })], forbidden_operations: ["delete_range"], expected_warning_codes: ["AMBIGUOUS_GLOBAL_COMPRESSION"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason", "does_not_guess_unannotated_time", "keeps_protected_range"] },
  { case_id: "llm_semantic_cut_004", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("mark_review_range", { start_ms: 0, end_ms: 55500 }, { reason_code: "HIGH_RISK_DELETE" })], forbidden_operations: ["delete_range"], expected_warning_codes: ["HIGH_RISK_DELETE"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason", "destructive_requires_confirmation"] },
  { case_id: "llm_semantic_cut_005", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("mark_review_range", { start_ms: 0, end_ms: 60000 }, { reason_code: "IMPORTANT_INFO_UNANNOTATED" })], forbidden_operations: ["delete_range"], expected_warning_codes: ["IMPORTANT_INFO_UNANNOTATED"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason", "does_not_guess_unannotated_time"] },
  { case_id: "llm_semantic_cut_006", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("delete_range", { start_ms: 36000, end_ms: 39000 }, { ripple: true })], forbidden_operations: [], expected_warning_codes: ["SEMANTIC_TIMING_FROM_TRANSCRIPT"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "destructive_requires_confirmation"] },
  { case_id: "llm_semantic_subtitle_007", expected_status: "succeeded", must_require_confirmation: true, expected_operations: [op("update_subtitle", { subtitle_id: "subtitle-account" }, { text: "请登录账号查看 Pro 版，价格 199 元" })], forbidden_operations: [], expected_warning_codes: ["BULK_SUBTITLE_REPLACE"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "preserves_product_names_and_numbers"] },
  { case_id: "llm_semantic_subtitle_008", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("mark_review_range", { start_ms: 9000, end_ms: 12000 }, { reason_code: "ENTITY_PRESERVATION_REVIEW" })], forbidden_operations: [], expected_warning_codes: ["ENTITY_PRESERVATION_REVIEW"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason", "preserves_product_names_and_numbers"] },
  { case_id: "llm_semantic_subtitle_009", expected_status: "succeeded", must_require_confirmation: true, expected_operations: [op("add_subtitle", { track_id: "subtitles" }, { start_ms: 12000, end_ms: 14000, text: "限时优惠", locale: "zh-CN" })], forbidden_operations: [], expected_warning_codes: ["USER_SELECTION_USED"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "destructive_requires_confirmation"] },
  { case_id: "llm_semantic_subtitle_010", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("mark_review_range", { start_ms: 9000, end_ms: 12000 }, { reason_code: "TRANSLATION_REVIEW" })], forbidden_operations: ["shift_subtitle_timing"], expected_warning_codes: ["TRANSLATION_REVIEW"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason"] },
  { case_id: "llm_semantic_audio_011", expected_status: "succeeded", must_require_confirmation: true, expected_operations: [op("adjust_audio", { clip_id: "voice-1" }, { volume_db: 4 })], forbidden_operations: ["delete_range"], expected_warning_codes: ["VOICE_TRACK_ONLY"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "audio_only_does_not_delete_video"] },
  { case_id: "llm_semantic_audio_012", expected_status: "succeeded", must_require_confirmation: true, expected_operations: [op("duck_music", { voice_track_id: "voice", music_track_id: "music" }, { duck_db: -9 })], forbidden_operations: [], expected_warning_codes: ["SPEECH_SEGMENTS_FROM_FIXTURE"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "audio_only_does_not_delete_video"] },
  { case_id: "llm_semantic_audio_013", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("mute_range", { track_id: "voice", start_ms: 43000, end_ms: 43700 }, { preserve_video: true })], forbidden_operations: ["delete_range"], expected_warning_codes: ["EVENT_TIMING_FROM_FIXTURE"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "audio_only_does_not_delete_video"] },
  { case_id: "llm_semantic_audio_014", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("equalize_loudness", { track_id: "voice" }, { target_lufs: -16 }), op("reduce_noise", { track_id: "voice" }, { strength: 0.35 })], forbidden_operations: [], expected_warning_codes: ["SUBJECTIVE_AUDIO_POLISH"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason"] },
  { case_id: "llm_semantic_audio_015", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("reduce_noise", { track_id: "voice" }, { strength: 0.45 })], forbidden_operations: [], expected_warning_codes: ["PERFECT_NOISE_REMOVAL_UNSUPPORTED"], expected_unsupported_intents: ["完全消除背景噪声"], semantic_assertions: ["request_id_echoed", "partial_explains_reason"] },
  { case_id: "llm_semantic_video_016", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("adjust_video", { clip_id: "video-1" }, { brightness: 0.08, contrast: 0.04 })], forbidden_operations: [], expected_warning_codes: ["GLOBAL_VIDEO_APPROXIMATION"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason"] },
  { case_id: "llm_semantic_video_017", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("adjust_video", { clip_id: "video-1" }, { contrast: 0.04, saturation: -0.03 })], forbidden_operations: [], expected_warning_codes: ["SUBJECTIVE_VIDEO_STYLE"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason"] },
  { case_id: "llm_semantic_video_018", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("mark_review_range", { start_ms: 0, end_ms: 24000 }, { reason_code: "CROP_REQUIRES_VISUAL_REVIEW" })], forbidden_operations: ["adjust_video"], expected_warning_codes: ["CROP_REQUIRES_VISUAL_REVIEW"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason"] },
  { case_id: "llm_semantic_video_019", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("mark_review_range", { start_ms: 0, end_ms: 45000 }, { reason_code: "UNSUPPORTED_OBJECT_REMOVAL" })], forbidden_operations: ["adjust_video"], expected_warning_codes: [], expected_unsupported_intents: ["对象移除"], semantic_assertions: ["request_id_echoed", "partial_explains_reason", "unsupported_generation_not_mapped_to_fake_filter"] },
  { case_id: "llm_semantic_multi_020", expected_status: "succeeded", must_require_confirmation: true, expected_operations: [op("delete_range", { start_ms: 0, end_ms: 3000 }, { ripple: true }, 0), op("adjust_audio", { clip_id: "voice-1" }, { volume_db: 3 }, 1), op("set_export_preset", { project_id: "real-llm-semantic-fixture" }, { preset: "1080p_landscape" }, 2)], forbidden_operations: [], expected_warning_codes: ["EXPORT_PRESET_ONLY"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "multi_step_order_preserved", "export_preset_does_not_start_export", "destructive_requires_confirmation"] },
  { case_id: "llm_semantic_multi_021", expected_status: "partial", must_require_confirmation: true, expected_operations: [op("apply_audio_fade", { clip_id: "voice-1" }, { fade_type: "in", duration_ms: 1000 })], forbidden_operations: ["move_clip"], expected_warning_codes: ["CHANGE_SPEED_UNSUPPORTED"], expected_unsupported_intents: ["变速"], semantic_assertions: ["request_id_echoed", "partial_explains_reason"] },
  { case_id: "llm_semantic_conflict_022", expected_status: "failed", must_require_confirmation: true, expected_operations: [], forbidden_operations: ["delete_range"], expected_warning_codes: [], expected_error_code: "CONFLICTING_INTENT", expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "failed_has_no_operations"] },
  { case_id: "llm_semantic_conflict_023", expected_status: "partial", must_require_confirmation: true, expected_operations: [], forbidden_operations: ["mute_range"], expected_warning_codes: ["CONFLICTING_AUDIO_INTENT"], expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "partial_explains_reason"] },
  { case_id: "llm_semantic_safety_024", expected_status: "failed", must_require_confirmation: true, expected_operations: [], forbidden_operations: ["set_export_preset"], expected_warning_codes: [], expected_error_code: "SOURCE_FILE_PROTECTION", expected_unsupported_intents: [], semantic_assertions: ["request_id_echoed", "failed_has_no_operations", "does_not_modify_source"] },
];

export const getExpectedPlan = (caseId: string) => {
  const expected = EXPECTED_REAL_LLM_SEMANTIC_PLANS.find((plan) => plan.case_id === caseId);
  if (!expected) throw new Error(`Missing expected real LLM semantic plan: ${caseId}`);
  return expected;
};

export const promptSha256 = (prompt: string) => createHash("sha256").update(prompt).digest("hex");

export const buildRealLlmSemanticRequest = (semanticCase: RealLlmSemanticCase, requestId = randomUUID()): LlmEditRequest => ({
  request_id: requestId,
  project: { project_id: "real-llm-semantic-fixture", duration_ms: semanticCase.timeline_context.duration_ms, timeline_version: semanticCase.timeline_context.timeline_version },
  user_intent: { prompt: semanticCase.prompt_zh, locale: "zh-CN", scope: semanticCase.scope },
  context: {
    assets: [{ id: `${semanticCase.fixture_id}-asset`, kind: semanticCase.fixture_id === "podcast_mix_90s" ? "audio" : "video", originalName: "fixture-media", durationMs: semanticCase.timeline_context.duration_ms, width: 1920, height: 1080, fps: 30 }],
    clips: semanticCase.timeline_context.clips.map((clip) => ({ id: clip.id, trackId: clip.track_id, kind: clip.kind, startMs: clip.start_ms, endMs: clip.end_ms, text: clip.text, assetId: clip.kind === "subtitle" || clip.kind === "ai" ? undefined : `${semanticCase.fixture_id}-asset` })),
    subtitles: semanticCase.timeline_context.subtitles,
    available_operations: semanticCase.available_operations,
    audio: semanticCase.timeline_context.audio_analysis
      ? {
        tracks: semanticCase.timeline_context.tracks.filter((track) => track.kind === "audio").map((track) => ({ track_id: track.id, kind: "audio", role: track.role ?? "unknown", locked: track.locked, muted: false, clips: semanticCase.timeline_context.clips.filter((clip) => clip.track_id === track.id).map((clip) => clip.id) })),
        analysis: {
          analysis_source: semanticCase.timeline_context.audio_analysis.analysis_source,
          speech_segments: semanticCase.timeline_context.audio_analysis.speech_segments,
          silence_segments: semanticCase.timeline_context.audio_analysis.silence_segments,
          transcript_segments: semanticCase.timeline_context.audio_analysis.transcript_segments,
        },
      }
      : undefined,
  },
  constraints: { max_operations: 50, require_user_confirmation: true, do_not_modify_source_files: true },
});

export const buildRealLlmSemanticTimeline = (semanticCase: RealLlmSemanticCase): Timeline => ({
  version: semanticCase.timeline_context.timeline_version,
  durationMs: semanticCase.timeline_context.duration_ms,
  history: [],
  tracks: semanticCase.timeline_context.tracks.map((track) => ({
    id: track.id,
    kind: track.kind,
    name: track.id,
    locked: track.locked,
    role: track.role,
    clips: semanticCase.timeline_context.clips.filter((clip) => clip.track_id === track.id).map((clip) => ({ id: clip.id, trackId: clip.track_id, kind: clip.kind, startMs: clip.start_ms, endMs: clip.end_ms, sourceStartMs: 0, sourceEndMs: clip.end_ms - clip.start_ms, text: clip.text })),
  })),
});

