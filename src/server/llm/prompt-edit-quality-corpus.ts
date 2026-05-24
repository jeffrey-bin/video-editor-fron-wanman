import { AVAILABLE_OPERATIONS, type OperationType } from "@/server/editor/operation-schema";
import type { EditOperation } from "@/server/editor/operation-schema";
import type { LlmEditRequest } from "@/server/llm/edit-plan-protocol";
import type { Timeline } from "@/types/editor";

export type PromptQualityCategory =
  | "single_cut"
  | "polish"
  | "subtitle"
  | "multi_step"
  | "conflict"
  | "capability_boundary"
  | "timeline_safety"
  | "provider_consistency";

export type PromptQualityCase = {
  case_id: string;
  category: PromptQualityCategory;
  prompt: string;
  scope: LlmEditRequest["user_intent"]["scope"];
  expected_status: Array<"succeeded" | "partial" | "failed">;
  expected_operations: OperationType[];
  forbidden_operations?: OperationType[];
  risk: "low" | "medium" | "high";
  assertions: PromptQualityAssertions;
  timeline?: Timeline;
  request_overrides?: Partial<Pick<LlmEditRequest["context"], "available_operations">> & {
    max_operations?: number;
    timeline_version?: number;
  };
};

type PartialRecord<T> = T extends object ? { [K in keyof T]?: PartialRecord<T[K]> } : T;

export type PromptQualityOperationAssertion = {
  type: OperationType;
  target?: PartialRecord<EditOperation["target"]>;
  params?: PartialRecord<EditOperation["params"]>;
  within_scope?: boolean;
};

export type PromptQualityAssertions = {
  operations?: PromptQualityOperationAssertion[];
  unsupported_reason_includes?: string;
  warning_codes?: string[];
  error_code?: string;
  no_operations?: boolean;
  require_timeline_version_match?: boolean;
  max_operations?: number;
};

export const promptQualityTimeline = (): Timeline => ({
  version: 3,
  durationMs: 60000,
  history: [],
  tracks: [
    {
      id: "video_main",
      kind: "video",
      name: "主视频",
      clips: [
        { id: "clip_intro", trackId: "video_main", kind: "video", assetId: "asset_video", startMs: 0, endMs: 12000, sourceStartMs: 0, sourceEndMs: 12000 },
        { id: "clip_scene", trackId: "video_main", kind: "video", assetId: "asset_video", startMs: 12000, endMs: 42000, sourceStartMs: 12000, sourceEndMs: 42000 },
        { id: "clip_outro", trackId: "video_main", kind: "video", assetId: "asset_video", startMs: 42000, endMs: 60000, sourceStartMs: 42000, sourceEndMs: 60000 },
      ],
    },
    {
      id: "audio_main",
      kind: "audio",
      name: "主音频",
      clips: [{ id: "audio_bed", trackId: "audio_main", kind: "audio", assetId: "asset_audio", startMs: 0, endMs: 60000, sourceStartMs: 0, sourceEndMs: 60000 }],
    },
    {
      id: "subtitles",
      kind: "subtitle",
      name: "字幕",
      clips: [{ id: "subtitle_hello", trackId: "subtitles", kind: "subtitle", startMs: 50000, endMs: 53000, sourceStartMs: 50000, sourceEndMs: 53000, text: "欢迎来到演示" }],
    },
  ],
});

const c = (
  case_id: string,
  category: PromptQualityCategory,
  prompt: string,
  expected_operations: OperationType[],
  scope: LlmEditRequest["user_intent"]["scope"] = { type: "timeline", start_ms: 0, end_ms: 60000 },
  extra: Partial<PromptQualityCase> = {},
): PromptQualityCase => ({
  case_id,
  category,
  prompt,
  scope,
  expected_status: ["succeeded"],
  expected_operations,
  risk: "medium",
  ...extra,
  assertions: extra.assertions ?? inferAssertions(case_id, prompt, expected_operations, scope, extra),
});

const quotedText = (prompt: string) => prompt.match(/[“"](.+?)[”"]/)?.[1];

const secondsRange = (prompt: string) => {
  const match = prompt.match(/(\d+)\s*(?:到|-|~)\s*(\d+)\s*秒?/);
  if (!match) return null;
  return { start_ms: Number(match[1]) * 1000, end_ms: Number(match[2]) * 1000 };
};

const deleteTargetForPrompt = (prompt: string) => {
  const explicit = secondsRange(prompt);
  if (explicit) return explicit;
  const introAmount = prompt.match(/开头\s*(\d+)\s*秒|(\d+)\s*秒.*开头|前\s*(\d+)\s*秒/)?.slice(1).find(Boolean);
  const outroAmount = prompt.match(/最后\s*(\d+)\s*秒|片尾.*?(\d+)\s*秒/)?.slice(1).find(Boolean);
  if (outroAmount) return { start_ms: 60000 - Number(outroAmount) * 1000, end_ms: 60000 };
  return { start_ms: 0, end_ms: Number(introAmount ?? 3) * 1000 };
};

const scopedRange = (scope: LlmEditRequest["user_intent"]["scope"]) =>
  scope.type !== "timeline" && "start_ms" in scope && scope.start_ms !== undefined && scope.end_ms !== undefined
    ? { start_ms: scope.start_ms, end_ms: scope.end_ms }
    : { start_ms: 1000, end_ms: 5200 };

const inferOperationAssertion = (
  operation: OperationType,
  prompt: string,
  scope: LlmEditRequest["user_intent"]["scope"],
): PromptQualityOperationAssertion => {
  switch (operation) {
    case "delete_range":
      return { type: operation, target: deleteTargetForPrompt(prompt), params: { ripple: true }, within_scope: true };
    case "split_clip":
      return { type: operation, target: { clip_id: "clip_scene", at_ms: 18000 } };
    case "move_clip":
      return { type: operation, target: { clip_id: prompt.includes("clip_outro") ? "clip_outro" : "clip_scene" }, params: { start_ms: Number(prompt.match(/(\d+)\s*秒/)?.[1] ?? 20) * 1000 } };
    case "trim_clip":
      return { type: operation, target: { clip_id: scope.type === "clip" ? scope.clip_ids[0] : "clip_intro" }, params: { timeline_start_ms: 1000, timeline_end_ms: 9000 } };
    case "adjust_video":
      return {
        type: operation,
        target: { clip_id: scope.type === "clip" ? scope.clip_ids[0] : "clip_intro" },
        params: {
          brightness: /亮|明亮/.test(prompt) ? 0.08 : undefined,
          contrast: /对比度|自然|肤色/.test(prompt) ? 0.05 : undefined,
          saturation: /饱和度|自然|肤色/.test(prompt) ? 0.04 : undefined,
        },
        within_scope: true,
      };
    case "adjust_audio":
      return {
        type: operation,
        target: { clip_id: "audio_bed" },
        params: {
          normalize: /人声|降噪|声音|音频|增强|音量/.test(prompt) ? true : undefined,
          volume_db: /人声|声音|增强|音量/.test(prompt) ? 2 : undefined,
          muted: /静音/.test(prompt) ? true : undefined,
          fade_in_ms: /淡入/.test(prompt) ? 1000 : undefined,
          fade_out_ms: /淡出/.test(prompt) ? 1000 : undefined,
        },
        within_scope: true,
      };
    case "add_subtitle": {
      const range = scopedRange(scope);
      return {
        type: operation,
        target: { track_id: "subtitles" },
        params: {
          ...range,
          text: quotedText(prompt) ?? (/英文字幕|welcome/i.test(prompt) ? "welcome to the demo" : "这里的风景真的太美了"),
          locale: /英文字幕|welcome/i.test(prompt) ? "en-US" : "zh-CN",
        },
        within_scope: true,
      };
    }
    case "update_subtitle":
      return { type: operation, target: { subtitle_id: "subtitle_hello" }, params: { text: quotedText(prompt) ?? "大家好" } };
    case "set_export_preset":
      return { type: operation, target: { project_id: "prompt-quality-project" }, params: { preset: /720p|预览/.test(prompt) ? "720p_preview" : /源质量/.test(prompt) ? "source" : "1080p_landscape" } };
  }
};

const inferAssertions = (
  case_id: string,
  prompt: string,
  expectedOperations: OperationType[],
  scope: LlmEditRequest["user_intent"]["scope"],
  extra: Partial<PromptQualityCase>,
): PromptQualityAssertions => {
  const assertions: PromptQualityAssertions = {
    operations: expectedOperations.map((operation) => inferOperationAssertion(operation, prompt, scope)),
    max_operations: extra.request_overrides?.max_operations,
  };
  if (expectedOperations.length === 0) assertions.no_operations = true;
  if (extra.request_overrides?.timeline_version !== undefined) assertions.require_timeline_version_match = true;
  if (case_id.startsWith("unsupported_") || case_id === "consistency_partial") assertions.unsupported_reason_includes = "当前版本";
  if (case_id === "consistency_error_no_media") assertions.error_code = "NO_MEDIA";
  return assertions;
};

export const PROMPT_EDIT_QUALITY_CASES: PromptQualityCase[] = [
  c("cut_intro_005", "single_cut", "删掉开头 5 秒空白，后面的内容整体前移", ["delete_range"]),
  c("cut_outro_006", "single_cut", "删除最后 6 秒片尾", ["delete_range"]),
  c("cut_middle_010_020", "single_cut", "删除 10 到 20 秒之间的停顿", ["delete_range"]),
  c("split_scene_018", "single_cut", "在 18 秒处分割 clip_scene", ["split_clip"]),
  c("move_scene_030", "single_cut", "把 clip_scene 移动到 20 秒开始", ["move_clip"], undefined, {
    timeline: {
      ...promptQualityTimeline(),
      tracks: promptQualityTimeline().tracks.map((track) =>
        track.id === "video_main"
          ? {
              ...track,
              clips: [
                { id: "clip_intro", trackId: "video_main", kind: "video", assetId: "asset_video", startMs: 0, endMs: 5000, sourceStartMs: 0, sourceEndMs: 5000 },
                { id: "clip_scene", trackId: "video_main", kind: "video", assetId: "asset_video", startMs: 10000, endMs: 18000, sourceStartMs: 10000, sourceEndMs: 18000 },
                { id: "clip_outro", trackId: "video_main", kind: "video", assetId: "asset_video", startMs: 30000, endMs: 40000, sourceStartMs: 30000, sourceEndMs: 40000 },
              ],
            }
          : track,
      ),
    },
  }),
  c("trim_clip_intro", "single_cut", "把 clip_intro 裁剪到 1 秒到 9 秒", ["trim_clip"], { type: "clip", clip_ids: ["clip_intro"] }),

  c("polish_brightness", "polish", "画面提亮一点", ["adjust_video"]),
  c("polish_contrast", "polish", "增加一点对比度", ["adjust_video"]),
  c("polish_saturation", "polish", "增强饱和度但保持自然", ["adjust_video"]),
  c("polish_voice", "polish", "增强人声并做音量均衡", ["adjust_audio"]),
  c("polish_mute_range", "polish", "把这段静音", ["adjust_audio"], { type: "selection", start_ms: 10000, end_ms: 15000 }),
  c("polish_fade", "polish", "给音频加 1 秒淡入淡出", ["adjust_audio"]),

  c("subtitle_add_cn", "subtitle", "添加中文字幕“欢迎来到今天的演示”", ["add_subtitle"], { type: "selection", start_ms: 10000, end_ms: 15000 }),
  c("subtitle_update_text", "subtitle", "把 subtitle_hello 改成“大家好”", ["update_subtitle"], { type: "subtitle", subtitle_ids: ["subtitle_hello"] }),
  c("subtitle_selection", "subtitle", "在选区内加字幕“重点来了”", ["add_subtitle"], { type: "selection", start_ms: 18000, end_ms: 22000 }),
  c("subtitle_oob", "subtitle", "给 70 到 75 秒添加字幕", [], { type: "subtitle", start_ms: 70000, end_ms: 75000 }, { expected_status: ["partial", "failed"], risk: "high" }),
  c("subtitle_empty_reject", "subtitle", "添加空字幕", [], { type: "selection", start_ms: 1000, end_ms: 2000 }, { expected_status: ["partial", "failed"], risk: "high" }),
  c("subtitle_locale_en", "subtitle", "添加英文字幕 welcome to the demo", ["add_subtitle"], { type: "selection", start_ms: 22000, end_ms: 25000 }),

  c("multi_cut_subtitle", "multi_step", "删掉开头 3 秒并添加字幕“正式开始”", ["delete_range", "add_subtitle"]),
  c("multi_cut_audio", "multi_step", "删除 10 到 12 秒并增强人声", ["delete_range", "adjust_audio"]),
  c("multi_subtitle_video", "multi_step", "添加字幕并让画面更明亮自然", ["add_subtitle", "adjust_video"]),
  c("multi_cut_export", "multi_step", "剪掉片尾并设置 720p 预览导出", ["delete_range", "set_export_preset"]),
  c("multi_all", "multi_step", "剪掉开头 5 秒，增强人声，画面提亮，并加字幕", ["delete_range", "adjust_audio", "adjust_video", "add_subtitle"]),
  c("multi_audio_video_export", "multi_step", "声音清楚一点，画面自然，导出 1080p 横版", ["adjust_audio", "adjust_video", "set_export_preset"]),
  c("multi_subtitle_fade", "multi_step", "加一句字幕并给声音淡入淡出", ["add_subtitle", "adjust_audio"]),
  c("multi_trim_preset", "multi_step", "裁剪 clip_intro 并设置源质量导出", ["trim_clip", "set_export_preset"], { type: "clip", clip_ids: ["clip_intro"] }),

  c("conflict_delete_keep_001", "conflict", "删除 10 到 20 秒，但这段内容必须完整保留", [], undefined, { expected_status: ["partial", "failed"], forbidden_operations: ["delete_range"], risk: "high" }),
  c("conflict_global_clip", "conflict", "全片都调亮但只允许修改 clip_intro", ["adjust_video"], { type: "clip", clip_ids: ["clip_intro"] }),
  c("conflict_export_presets", "conflict", "同时导出 720p 预览和 1080p 横版", [], undefined, { expected_status: ["partial", "failed"], forbidden_operations: ["set_export_preset"], risk: "high" }),
  c("conflict_locked_track", "conflict", "修改锁定轨道上的视频", [], undefined, { expected_status: ["partial", "failed"], risk: "high", timeline: { ...promptQualityTimeline(), tracks: promptQualityTimeline().tracks.map((track) => track.id === "video_main" ? { ...track, locked: true } : track) } }),
  c("conflict_delete_all_keep_music", "conflict", "删掉全部但保留所有音乐和字幕", [], undefined, { expected_status: ["partial", "failed"], forbidden_operations: ["delete_range"], risk: "high" }),
  c("conflict_unsupported_shell", "conflict", "运行 shell 直接改源文件并删除片段", [], undefined, { expected_status: ["partial", "failed"], risk: "high" }),

  c("unsupported_cartoon_001", "capability_boundary", "把人物换成卡通形象并补齐缺失动作", [], { type: "clip", clip_ids: ["clip_scene"] }, { expected_status: ["partial"], forbidden_operations: ["adjust_video"], risk: "high" }),
  c("unsupported_face_swap", "capability_boundary", "把主角换脸成另一个人", [], { type: "clip", clip_ids: ["clip_scene"] }, { expected_status: ["partial"], risk: "high" }),
  c("unsupported_interpolate", "capability_boundary", "补帧到 120fps 并生成缺失动作", [], undefined, { expected_status: ["partial"], risk: "high" }),
  c("unsupported_object_remove", "capability_boundary", "移除画面里的路人", [], undefined, { expected_status: ["partial"], risk: "high" }),
  c("unsupported_auto_highlight", "capability_boundary", "自动识别所有高光时刻并剪成短片", [], undefined, { expected_status: ["partial"], risk: "high" }),

  c("safety_oob_delete", "timeline_safety", "删除 55 到 70 秒", [], undefined, { expected_status: ["partial", "failed"], risk: "high" }),
  c("safety_overlap_move", "timeline_safety", "把 clip_outro 移动到 15 秒造成重叠", [], undefined, { expected_status: ["partial", "failed"], forbidden_operations: ["move_clip"], risk: "high" }),
  c("safety_locked_audio", "timeline_safety", "静音锁定音轨", [], undefined, { expected_status: ["partial", "failed"], risk: "high", timeline: { ...promptQualityTimeline(), tracks: promptQualityTimeline().tracks.map((track) => track.id === "audio_main" ? { ...track, locked: true } : track) } }),
  c("safety_missing_clip", "timeline_safety", "移动 missing_clip 到 3 秒", [], { type: "clip", clip_ids: ["missing_clip"] }, { expected_status: ["partial", "failed"], risk: "high" }),
  c("safety_old_version", "timeline_safety", "基于旧版本剪掉开头", [], undefined, { expected_status: ["partial", "failed"], risk: "high", request_overrides: { timeline_version: 1 } }),
  c("safety_max_operations", "timeline_safety", "剪辑、字幕、音频、画面和导出都处理", ["adjust_audio"], undefined, { request_overrides: { max_operations: 1 } }),
  c("safety_available_operations", "timeline_safety", "只允许字幕能力时剪掉开头 5 秒", [], undefined, { expected_status: ["partial", "failed"], risk: "high", request_overrides: { available_operations: ["add_subtitle"] } }),

  c("consistency_schema", "provider_consistency", "剪掉开头 5 秒", ["delete_range"]),
  c("consistency_partial", "provider_consistency", "把人物卡通化", [], undefined, { expected_status: ["partial"], risk: "high" }),
  c("consistency_error_no_media", "provider_consistency", "剪掉开头", [], undefined, { expected_status: ["failed"], risk: "high", timeline: { version: 3, durationMs: 60000, history: [], tracks: [] } }),
  c("consistency_confirmation", "provider_consistency", "删除 10 到 20 秒并增强人声", ["delete_range", "adjust_audio"], undefined, { risk: "high" }),
];

export const buildPromptQualityRequest = (qualityCase: PromptQualityCase): LlmEditRequest => {
  const timeline = qualityCase.timeline ?? promptQualityTimeline();
  const clips = timeline.tracks.flatMap((track) =>
    track.clips.map((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      kind: clip.kind,
      startMs: clip.startMs,
      endMs: clip.endMs,
      assetId: clip.assetId,
      text: clip.text,
    })),
  );
  return {
    request_id: `550e8400-e29b-41d4-a716-${qualityCase.case_id.slice(0, 12).padEnd(12, "0").replace(/[^a-f0-9]/g, "0")}`,
    project: {
      project_id: "prompt-quality-project",
      duration_ms: timeline.durationMs,
      timeline_version: qualityCase.request_overrides?.timeline_version ?? timeline.version,
    },
    user_intent: { prompt: qualityCase.prompt, locale: "zh-CN", scope: qualityCase.scope },
    context: {
      assets: [
        { id: "asset_video", kind: "video", originalName: "travel-vlog.mp4", durationMs: 60000, width: 1920, height: 1080, fps: 30 },
        { id: "asset_audio", kind: "audio", originalName: "voice.wav", durationMs: 60000 },
      ],
      clips,
      subtitles: clips.filter((clip) => clip.kind === "subtitle" && clip.text).map((clip) => ({ id: clip.id, start_ms: clip.startMs, end_ms: clip.endMs, text: clip.text ?? "" })),
      available_operations: qualityCase.request_overrides?.available_operations ?? AVAILABLE_OPERATIONS,
    },
    constraints: { max_operations: qualityCase.request_overrides?.max_operations ?? 50, require_user_confirmation: true, do_not_modify_source_files: true },
  };
};
