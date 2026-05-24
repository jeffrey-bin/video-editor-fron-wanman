import type { EditOperation } from "@/server/editor/operation-schema";
import type { EditPlanResponse, LlmEditRequest } from "@/server/llm/edit-plan-protocol";

const firstEditableClip = (input: LlmEditRequest) =>
  input.context.clips.find((clip) => clip.kind === "video") ?? input.context.clips.find((clip) => clip.kind === "audio");

const firstAudioClip = (input: LlmEditRequest) => input.context.clips.find((clip) => clip.kind === "audio");

const firstVideoClip = (input: LlmEditRequest) => {
  const scopedClipIds = input.user_intent.scope.type === "clip" ? input.user_intent.scope.clip_ids : [];
  return input.context.clips.find((clip) => clip.kind === "video" && scopedClipIds.includes(clip.id)) ?? input.context.clips.find((clip) => clip.kind === "video");
};

const subtitleClip = (input: LlmEditRequest) => {
  const scopedSubtitleIds = input.user_intent.scope.type === "subtitle" ? input.user_intent.scope.subtitle_ids ?? [] : [];
  return input.context.clips.find((clip) => clip.kind === "subtitle" && scopedSubtitleIds.includes(clip.id)) ?? input.context.clips.find((clip) => clip.kind === "subtitle");
};

const hasOperation = (input: LlmEditRequest, type: EditOperation["type"]) => input.context.available_operations.includes(type);

const secondsRange = (prompt: string) => {
  const match = prompt.match(/(\d+)\s*(?:到|-|~)\s*(\d+)\s*秒?/);
  if (!match) return null;
  return { start_ms: Number(match[1]) * 1000, end_ms: Number(match[2]) * 1000 };
};

const selectedRange = (input: LlmEditRequest) => {
  const scope = input.user_intent.scope;
  if (scope.type !== "timeline" && "start_ms" in scope && "end_ms" in scope && scope.start_ms !== undefined && scope.end_ms !== undefined) {
    return { start_ms: scope.start_ms, end_ms: scope.end_ms };
  }
  return { start_ms: 1000, end_ms: Math.min(5200, input.project.duration_ms) };
};

const partialPlan = (
  input: LlmEditRequest,
  summary: string,
  warnings: EditPlanResponse["warnings"],
  unsupported_intents: EditPlanResponse["unsupported_intents"] = [],
): EditPlanResponse => ({
  request_id: input.request_id,
  status: "partial",
  summary,
  confidence: 0.54,
  requires_confirmation: true,
  warnings,
  operations: [],
  unsupported_intents,
});

export const generateMockEditPlan = async (input: LlmEditRequest): Promise<EditPlanResponse> => {
  const prompt = input.user_intent.prompt;
  const clip = firstEditableClip(input);
  if (!clip) {
    return {
      request_id: input.request_id,
      status: "failed",
      summary: "没有可编辑素材。",
      confidence: 0.2,
      requires_confirmation: true,
      warnings: [],
      operations: [],
      unsupported_intents: [],
      error: { code: "NO_MEDIA", message: "请先导入视频或音频素材。" },
    };
  }

  if (/旧版本|timeline_version|版本不一致/.test(prompt) || input.user_intent.scope.type === "clip" && input.user_intent.scope.clip_ids.some((clipId) => !input.context.clips.some((candidate) => candidate.id === clipId))) {
    return partialPlan(input, "当前时间线状态需要重新确认后再生成方案。", [{ code: "STALE_OR_MISSING_TARGET", message: "目标片段缺失或请求基于旧版本时间线。" }]);
  }

  if (/卡通|换脸|补帧|对象移除|移除画面|高光|缺失动作/.test(prompt)) {
    return partialPlan(
      input,
      "该请求包含当前版本不支持的生成式或自动识别能力，未生成伪造的可执行修改。",
      [],
      [{ intent: "生成式视频重绘/自动内容理解", reason: "P0/P3 当前版本只支持剪辑、字幕、音频和基础画面参数，不能换脸、补帧、移除对象或自动识别高光。" }],
    );
  }

  if (/shell|源文件|完整保留|同时导出|删掉全部|锁定|造成重叠|空字幕/.test(prompt)) {
    return partialPlan(input, "Prompt 包含冲突、高风险或不安全指令，需用户重新确认。", [{ code: "CONFLICT_OR_UNSAFE_INTENT", message: "未生成会破坏时间线或绕过源文件保护的操作。" }]);
  }

  const operations: EditOperation[] = [];
  const requestedRange = secondsRange(prompt);
  if ((requestedRange && /删除|删掉|剪掉/.test(prompt)) || /开头|空白|片尾|最后|前\s*\d/.test(prompt)) {
    const introAmount = prompt.match(/开头\s*(\d+)\s*秒|(\d+)\s*秒.*开头|前\s*(\d+)\s*秒/)?.slice(1).find(Boolean);
    const outroAmount = prompt.match(/最后\s*(\d+)\s*秒|片尾.*?(\d+)\s*秒/)?.slice(1).find(Boolean);
    const target = requestedRange
      ? requestedRange
      : outroAmount
        ? { start_ms: Math.max(0, input.project.duration_ms - Number(outroAmount) * 1000), end_ms: input.project.duration_ms }
        : { start_ms: 0, end_ms: Math.min(Number(introAmount ?? 3) * 1000, input.project.duration_ms) };
    if (target.end_ms > input.project.duration_ms || (/删除\s*0\s*(?:到|-|~)\s*30\s*秒/.test(prompt) && target.end_ms - target.start_ms > input.project.duration_ms * 0.2)) {
      return partialPlan(input, "删除范围越界或超过总时长 20%，需要更明确确认。", [{ code: "HIGH_RISK_DELETE", message: "高风险删除不会由 mock provider 直接生成可应用操作。" }]);
    }
    if (!hasOperation(input, "delete_range")) {
      return partialPlan(input, "当前请求没有可用操作可表达。", [{ code: "NO_AVAILABLE_OPERATION", message: "available_operations 未包含 delete_range。" }]);
    }
    operations.push({
      id: "op_delete_range",
      type: "delete_range",
      target,
      params: { ripple: true },
      rationale: "根据 Prompt 删除指定时间范围并波纹前移。",
    });
  }
  if (/裁剪|trim/.test(prompt) && hasOperation(input, "trim_clip")) {
    const videoClip = firstVideoClip(input);
    if (videoClip) {
      operations.push({
        id: "op_trim_clip",
        type: "trim_clip",
        target: { clip_id: videoClip.id },
        params: { timeline_start_ms: videoClip.startMs + 1000, timeline_end_ms: Math.max(videoClip.startMs + 2000, videoClip.endMs - 3000) },
        rationale: "根据 Prompt 收紧目标片段的时间线范围。",
      });
    }
  }
  if (/分割|拆分|切开/.test(prompt) && hasOperation(input, "split_clip")) {
    const targetClipId = input.context.clips.find((candidate) => prompt.includes(candidate.id))?.id;
    const videoClip = input.context.clips.find((candidate) => candidate.id === targetClipId && candidate.kind === "video") ?? firstVideoClip(input);
    const atMs = Number(prompt.match(/(\d+)\s*秒/)?.[1] ?? 18) * 1000;
    if (videoClip && atMs > videoClip.startMs && atMs < videoClip.endMs) {
      operations.push({
        id: "op_split_clip",
        type: "split_clip",
        target: { clip_id: videoClip.id, at_ms: atMs },
        params: {},
        rationale: "在用户指定时间点拆分片段。",
      });
    }
  }
  if (/移动/.test(prompt) && hasOperation(input, "move_clip")) {
    const targetClipId = input.context.clips.find((candidate) => prompt.includes(candidate.id))?.id;
    const targetClip = input.context.clips.find((candidate) => candidate.id === targetClipId) ?? firstVideoClip(input);
    const startMs = Number(prompt.match(/(\d+)\s*秒/)?.[1] ?? 20) * 1000;
    if (targetClip) {
      operations.push({
        id: "op_move_clip",
        type: "move_clip",
        target: { clip_id: targetClip.id },
        params: { start_ms: startMs },
        rationale: "根据 Prompt 移动目标片段。",
      });
    }
  }
  if (/亮|自然|肤色|润色|明亮|对比度|饱和度/.test(prompt) && hasOperation(input, "adjust_video")) {
    const videoClip = firstVideoClip(input);
    if (videoClip) {
      operations.push({
        id: "op_video_polish",
        type: "adjust_video",
        target: { clip_id: videoClip.id },
        params: {
          brightness: /亮|明亮/.test(prompt) ? 0.08 : undefined,
          contrast: /对比度|自然|肤色/.test(prompt) ? 0.05 : undefined,
          saturation: /饱和度|自然|肤色/.test(prompt) ? 0.04 : undefined,
        },
        rationale: "轻度提升画面亮度、对比度或饱和度。",
      });
    }
  }
  if (/人声|降噪|噪声|声音|音频|增强|静音|淡入|淡出|音量/.test(prompt) && hasOperation(input, "adjust_audio")) {
    const audioClip = firstAudioClip(input);
    if (audioClip) {
      operations.push({
        id: "op_audio_enhance",
        type: "adjust_audio",
        target: { clip_id: audioClip.id },
        params: {
          normalize: /人声|降噪|声音|音频|增强|音量/.test(prompt) ? true : undefined,
          volume_db: /人声|声音|增强|音量/.test(prompt) ? 2 : undefined,
          muted: /静音/.test(prompt) ? true : undefined,
          fade_in_ms: /淡入/.test(prompt) ? 1000 : undefined,
          fade_out_ms: /淡出/.test(prompt) ? 1000 : undefined,
        },
        rationale: "根据 Prompt 调整音频响度、静音或淡入淡出。",
      });
    }
  }
  if (/字幕|caption|英文字幕|subtitle_/i.test(prompt) || input.user_intent.scope.type === "subtitle") {
    if (/改成|修正|更新/.test(prompt) && hasOperation(input, "update_subtitle")) {
      const subtitle = subtitleClip(input);
      if (subtitle) {
        operations.push({
          id: "op_update_subtitle",
          type: "update_subtitle",
          target: { subtitle_id: subtitle.id },
          params: { text: prompt.match(/[“"](.+?)[”"]/)?.[1] ?? "大家好" },
          rationale: "根据 Prompt 更新已有字幕文本。",
        });
      }
    } else if (hasOperation(input, "add_subtitle")) {
      const range = selectedRange(input);
      if (range.end_ms > input.project.duration_ms) {
        return partialPlan(input, "字幕时间范围超出项目时长。", [{ code: "SUBTITLE_RANGE_OUT_OF_BOUNDS", message: "请重新选择字幕时间范围。" }]);
      }
      operations.push({
        id: "op_add_subtitle",
        type: "add_subtitle",
        target: { track_id: "subtitles" },
        params: {
          start_ms: range.start_ms,
          end_ms: range.end_ms,
          text: prompt.match(/[“"](.+?)[”"]/)?.[1] ?? (/英文字幕/i.test(prompt) ? "welcome to the demo" : "这里的风景真的太美了"),
          locale: /英文字幕|welcome/i.test(prompt) ? "en-US" : "zh-CN",
        },
        rationale: "根据 Prompt 添加字幕。",
      });
    }
  }
  if (/导出|预览|1080p|720p|源质量/.test(prompt) && hasOperation(input, "set_export_preset")) {
    operations.push({
      id: "op_export_preset",
      type: "set_export_preset",
      target: { project_id: input.project.project_id },
      params: { preset: /720p|预览/.test(prompt) ? "720p_preview" : /源质量/.test(prompt) ? "source" : "1080p_landscape" },
      rationale: "只记录导出预设意图，不直接启动导出。",
    });
  }
  if (operations.length === 0) {
    if (!hasOperation(input, "add_subtitle")) {
      return partialPlan(input, "当前请求没有可用操作可表达。", [{ code: "NO_AVAILABLE_OPERATION", message: "available_operations 未包含安全替代操作。" }]);
    }
    operations.push({
      id: "op_add_marker_subtitle",
      type: "add_subtitle",
      target: { track_id: "subtitles" },
      params: { start_ms: 0, end_ms: Math.min(3000, input.project.duration_ms), text: "AI 已生成可审阅编辑方案", locale: "zh-CN" },
      rationale: "使用低风险字幕操作作为可预览方案。",
    });
  }

  return {
    request_id: input.request_id,
    status: "succeeded",
    summary: `已生成 ${operations.length} 个可审阅操作：剪辑、字幕或基础润色参数。`,
    confidence: 0.82,
    requires_confirmation: true,
    warnings: [{ code: "MOCK_TIMING", message: "时间点来自本地模拟，请预览后确认。" }],
    operations: operations.slice(0, input.constraints.max_operations),
    unsupported_intents: [],
  };
};
