import type { EditOperation } from "@/server/editor/operation-schema";
import type { EditPlanResponse, LlmEditRequest } from "@/server/llm/edit-plan-protocol";

const firstEditableClip = (input: LlmEditRequest) =>
  input.context.clips.find((clip) => clip.kind === "video") ?? input.context.clips.find((clip) => clip.kind === "audio");

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

  const operations: EditOperation[] = [];
  if (/开头|空白|前\s*\d/.test(prompt)) {
    const amount = prompt.match(/(\d+)\s*秒/)?.[1];
    operations.push({
      id: "op_delete_intro",
      type: "delete_range",
      target: { start_ms: 0, end_ms: Math.min(Number(amount ?? 3) * 1000, input.project.duration_ms) },
      params: { ripple: true },
      rationale: "根据 Prompt 删除开头空白。",
    });
  }
  if (/亮|自然|肤色|润色|明亮/.test(prompt)) {
    operations.push({
      id: "op_video_polish",
      type: "adjust_video",
      target: { clip_id: clip.id },
      params: { brightness: 0.08, contrast: 0.05, saturation: 0.04 },
      rationale: "轻度提升画面亮度和饱和度。",
    });
  }
  if (/人声|降噪|噪声|声音|音频|增强/.test(prompt)) {
    operations.push({
      id: "op_audio_enhance",
      type: "adjust_audio",
      target: { clip_id: clip.id },
      params: { normalize: true, volume_db: 2 },
      rationale: "对人声做响度标准化并略微增益。",
    });
  }
  if (/字幕|断句|caption/i.test(prompt)) {
    operations.push({
      id: "op_add_subtitle",
      type: "add_subtitle",
      target: { track_id: "subtitles" },
      params: { start_ms: 1000, end_ms: Math.min(5200, input.project.duration_ms), text: "这里的风景真的太美了", locale: "zh-CN" },
      rationale: "根据 Prompt 添加一条中文字幕示例。",
    });
  }
  if (operations.length === 0) {
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
    unsupported_intents: /卡通|换脸|补帧|对象移除/.test(prompt)
      ? [{ intent: "生成式视频重绘", reason: "P0 仅支持剪辑、字幕和基础音视频参数。" }]
      : [],
  };
};
