import type { EditOperation } from "@/server/editor/operation-schema";
import type { EditPlanResponse, LlmEditRequest } from "@/server/llm/edit-plan-protocol";

const firstEditableClip = (input: LlmEditRequest) =>
  input.context.clips.find((clip) => clip.kind === "video") ?? input.context.clips.find((clip) => clip.kind === "audio");

const firstAudioClip = (input: LlmEditRequest) => input.context.clips.find((clip) => clip.kind === "audio");
const audioTracks = (input: LlmEditRequest) =>
  input.context.audio?.tracks ??
  input.context.clips
    .filter((clip) => clip.kind === "audio")
    .map((clip) => ({
      track_id: clip.trackId,
      kind: "audio" as const,
      role: clip.trackId.includes("music") ? "music" as const : "voice" as const,
      locked: false,
      muted: false,
      clips: [clip.id],
    }));
const trackByRole = (input: LlmEditRequest, role: "voice" | "music") => audioTracks(input).find((track) => track.role === role);
const firstTranscript = (input: LlmEditRequest) => input.context.audio?.analysis.transcript_segments?.[0];

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
  operations: EditOperation[] = [],
): EditPlanResponse => ({
  request_id: input.request_id,
  status: "partial",
  summary,
  confidence: 0.54,
  requires_confirmation: true,
  warnings,
  operations,
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
  if (/声音克隆|克隆声音|换成.*声音|生成.*音乐|作曲|完美去噪|完全去除/.test(prompt)) {
    return partialPlan(input, "该请求包含 P4 不支持的音频生成或身份改变能力，未生成可执行操作。", [], [
      { intent: "生成式音频或完美修复", reason: "当前版本支持降噪、响度、ducking、静音、淡入淡出、字幕和同步，不支持声音克隆、生成音乐或承诺完美去噪。" },
    ]);
  }

  if (/shell|源文件|完整保留|同时导出|删掉全部|锁定|造成重叠|空字幕/.test(prompt)) {
    return partialPlan(input, "Prompt 包含冲突、高风险或不安全指令，需用户重新确认。", [{ code: "CONFLICT_OR_UNSAFE_INTENT", message: "未生成会破坏时间线或绕过源文件保护的操作。" }]);
  }

  const operations: EditOperation[] = [];
  const requestedRange = secondsRange(prompt);
  const hasAudioContext = input.context.audio !== undefined;
  const wantsAudioP4 = /降噪|噪声|噪音|电流声|风噪|清楚|音量|忽大忽小|爆音|响度|背景音乐|配乐|duck|压低|盖住|静音|淡入|淡出|结尾|字幕|转写|同步|对齐|提前|慢|延迟|早|晚/.test(prompt);
  if (wantsAudioP4 && audioTracks(input).length === 0) {
    return {
      request_id: input.request_id,
      status: "failed",
      summary: "没有可编辑音频轨。",
      confidence: 0.2,
      requires_confirmation: true,
      warnings: [],
      operations: [],
      unsupported_intents: [],
      error: { code: "NO_AUDIO_TRACK", message: "请先导入带音频的素材。" },
    };
  }
  const voiceTrack = trackByRole(input, "voice");
  const musicTrack = trackByRole(input, "music");
  const audioClip = firstAudioClip(input);
  const speechSegments = input.context.audio?.analysis.speech_segments ?? [];
  const analysisSource = input.context.audio?.analysis.analysis_source ?? "none";
  const ensureAvailable = (type: EditOperation["type"]) => {
    if (!hasOperation(input, type)) throw new Error(type);
  };
  try {
    if ((voiceTrack?.locked || musicTrack?.locked) && wantsAudioP4) {
      return partialPlan(input, "目标音频轨已锁定，未生成会修改锁定轨道的操作。", [{ code: "TRACK_LOCKED", message: "请解锁轨道后重试。" }]);
    }
    if (/降噪|底噪|噪声|噪音|电流声|风噪|清楚/.test(prompt)) {
      ensureAvailable("reduce_noise");
      if (analysisSource === "none" && !/明确|选区|这段/.test(prompt)) {
        return partialPlan(input, "需要先分析音频或指定范围后再生成降噪方案。", [{ code: "AUDIO_ANALYSIS_REQUIRED", message: "请运行分析或选择明确时间范围。" }]);
      }
      operations.push({
        id: "op_reduce_noise",
        type: "reduce_noise",
        target: { track_id: voiceTrack?.track_id, clip_id: audioClip?.id },
        params: { strength: /强|大幅/.test(prompt) ? 0.72 : 0.45, noise_profile: /电流/.test(prompt) ? "hum" : /风/.test(prompt) ? "wind" : "auto", preserve_voice: true, target_noise_floor_dbfs: -50 },
        rationale: "降低稳定背景噪声并保留人声可懂度。",
      });
    }
    if (/音量|忽大忽小|爆音|响度|统一|稳定|短视频|适合/.test(prompt)) {
      ensureAvailable("equalize_loudness");
      operations.push({
        id: "op_equalize_loudness",
        type: "equalize_loudness",
        target: { track_id: voiceTrack?.track_id, clip_id: audioClip?.id },
        params: { target_lufs: -16, max_gain_db: /很小|大幅/.test(prompt) ? 10 : 6, limit_peak_dbfs: -1, scope_mode: "track" },
        rationale: "统一人声响度并限制峰值，降低削波风险。",
      });
    }
    if (/duck|压低|盖住|恢复|背景音乐.*(?:小|低)|配乐.*(?:小|低)/.test(prompt)) {
      ensureAvailable("duck_music");
      if (!voiceTrack || !musicTrack) {
        const mixedTrack = audioTracks(input).find((track) => track.role === "mixed");
        const range = selectedRange(input);
        const reviewOperation: EditOperation[] = hasOperation(input, "mark_review_range") && mixedTrack
          ? [{
            id: "op_review_mixed_track_ducking",
            type: "mark_review_range",
            target: { track_id: "ai_markers", start_ms: range.start_ms, end_ms: range.end_ms },
            params: { reason_code: "MEDIA_UNSUPPORTED_SEMANTIC", suggested_action: "混合音轨无法可靠分离人声和配乐，请拆分为 voice/music 轨后再执行 ducking。" },
            rationale: "标记需要人工拆轨确认的混合音轨范围，避免伪造配乐闪避结果。",
          }]
          : [];
        return partialPlan(input, "已理解配乐闪避意图，但需要先选择人声轨和配乐轨。", [{ code: "TRACK_ROLE_UNKNOWN", message: "请选择 voice/music 轨道后重试。" }], [], reviewOperation);
      }
      if (speechSegments.length === 0) {
        return partialPlan(input, "已理解配乐闪避意图，但需要先分析讲话段。", [{ code: "AUDIO_ANALYSIS_REQUIRED", message: "请运行音频分析获得 speech_segments。" }]);
      }
      operations.push({
        id: "op_duck_music",
        type: "duck_music",
        target: { voice_track_id: voiceTrack.track_id, music_track_id: musicTrack.track_id },
        params: { duck_db: -9, attack_ms: 120, release_ms: 650, segments: speechSegments.map((segment) => ({ start_ms: segment.start_ms, end_ms: segment.end_ms, confidence: segment.confidence })) },
        rationale: "在人声出现时压低配乐，讲话结束后平滑恢复。",
      });
    }
    if (/静音|不要声音|关掉/.test(prompt)) {
      ensureAvailable("mute_range");
      const range = requestedRange ?? selectedRange(input);
      operations.push({
        id: "op_mute_range",
        type: "mute_range",
        target: { track_id: /背景音乐|配乐/.test(prompt) ? musicTrack?.track_id : voiceTrack?.track_id, start_ms: range.start_ms, end_ms: range.end_ms },
        params: { ramp_ms: 80, preserve_video: true },
        rationale: "静音指定音频范围，画面和时间线长度保持不变。",
      });
    }
    if (/淡入|淡出|不要突然断|结尾/.test(prompt)) {
      ensureAvailable("apply_audio_fade");
      if (audioClip) {
        operations.push({
          id: "op_audio_fade",
          type: "apply_audio_fade",
          target: { clip_id: audioClip.id, track_id: /配乐|音乐/.test(prompt) ? musicTrack?.track_id : voiceTrack?.track_id },
          params: { fade_type: /淡入/.test(prompt) && !/淡出|结尾/.test(prompt) ? "in" : "out", duration_ms: 1200, curve: "equal_power" },
          rationale: "对音频片段添加平滑淡入淡出，不作用于视频轨。",
        });
      }
    }
    if (hasAudioContext && /字幕|转写|他说的话/.test(prompt) && /生成|变成|转写|他说的话/.test(prompt)) {
      ensureAvailable("add_subtitle");
      const transcript = firstTranscript(input);
      if (!transcript) {
        return partialPlan(input, "当前没有可用转写文本，不能伪造字幕内容。", [{ code: "TRANSCRIPTION_UNAVAILABLE", message: "请提供文本或运行转写分析。" }]);
      }
      operations.push({
        id: "op_add_transcript_subtitle",
        type: "add_subtitle",
        target: { track_id: "subtitles" },
        params: { start_ms: transcript.start_ms, end_ms: transcript.end_ms, text: transcript.text, locale: "zh-CN", source: transcript.source === "fixture" ? "fixture_transcript" : "mock_transcript", confidence: transcript.confidence },
        rationale: "基于可用模拟转写生成字幕草稿，低置信度需确认。",
      });
    }
    if (/同步|对齐|提前|慢|延迟|早|晚/.test(prompt)) {
      const offset = Number(prompt.match(/(\d+)\s*ms|(\d+)\s*毫秒/)?.slice(1).find(Boolean) ?? input.context.audio?.analysis.av_sync_offset_ms ?? 0);
      if (!offset) return partialPlan(input, "需要明确偏移量或运行音画同步分析。", [{ code: "AUDIO_ANALYSIS_REQUIRED", message: "请指定例如 300ms 的偏移量。" }]);
      if (Math.abs(offset) > 3000) return partialPlan(input, "音频偏移量超出安全范围，未生成同步移动操作。", [{ code: "SYNC_SHIFT_OUT_OF_BOUNDS", message: "P4 默认拒绝超过 3000ms 的音频整体偏移。" }]);
      if (/字幕/.test(prompt)) {
        ensureAvailable("shift_subtitle_timing");
        operations.push({ id: "op_shift_subtitle", type: "shift_subtitle_timing", target: { track_id: "subtitles" }, params: { offset_ms: /提前|早/.test(prompt) ? -offset : offset }, rationale: "整体移动字幕时间，不改变字幕文本。" });
      } else {
        ensureAvailable("shift_audio");
        operations.push({ id: "op_shift_audio", type: "shift_audio", target: { track_id: voiceTrack?.track_id }, params: { offset_ms: /提前|早/.test(prompt) ? -offset : offset, fill_gap: "silence", affects_linked_video: false }, rationale: "整体移动音频以改善音画同步，不移动视频。" });
      }
    }
  } catch (error) {
    return partialPlan(input, "当前请求没有可用音频操作可表达。", [{ code: "NO_AVAILABLE_OPERATION", message: `available_operations 未包含 ${(error as Error).message}。` }]);
  }
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
  if ((/字幕|caption|英文字幕|subtitle_/i.test(prompt) || input.user_intent.scope.type === "subtitle") && !operations.some((operation) => operation.type === "add_subtitle")) {
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

  const audioWarnings: EditPlanResponse["warnings"] = [
    { code: "MOCK_TIMING", message: "时间点来自本地模拟，请预览后确认。" },
    ...(operations.some((operation) => operation.type === "reduce_noise" && operation.params.strength > 0.7) ? [{ code: "AUDIO_DISTORTION_RISK", message: "强降噪可能产生失真，需试听确认。" }] : []),
    ...(operations.some((operation) => (operation.type === "add_subtitle" || operation.type === "update_subtitle") && operation.params.confidence !== undefined && operation.params.confidence < 0.85) ? [{ code: "LOW_TRANSCRIPT_CONFIDENCE", message: "字幕来自模拟转写且置信度较低，需人工确认。" }] : []),
    ...(operations.some((operation) => operation.type === "add_subtitle" && operation.params.source !== undefined) ? [{ code: "MOCK_TRANSCRIPT_SOURCE", message: "字幕来自模拟/fixture 转写。" }] : []),
  ];
  return {
    request_id: input.request_id,
    status: "succeeded",
    summary: `已生成 ${operations.length} 个可审阅操作：剪辑、字幕、音频滤镜或基础润色参数。`,
    confidence: 0.82,
    requires_confirmation: true,
    warnings: audioWarnings,
    operations: operations.slice(0, input.constraints.max_operations),
    unsupported_intents: [],
  };
};
