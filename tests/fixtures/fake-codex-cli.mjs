#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

const emit = (plan) => {
  process.stdout.write(JSON.stringify(plan));
};

process.stdin.on("end", () => {
  const first = input.indexOf("{");
  const request = JSON.parse(input.slice(first));
  const prompt = request.user_intent.prompt;
  const base = {
    request_id: request.request_id,
    confidence: 0.82,
    requires_confirmation: true,
    warnings: [{ code: "MOCK_TIMING", message: "时间点来自本地模拟，请预览后确认。" }],
    unsupported_intents: [],
  };

  if (request.context.clips.length === 0) {
    emit({
      request_id: request.request_id,
      status: "failed",
      summary: "没有可编辑素材。",
      confidence: 0.2,
      requires_confirmation: true,
      warnings: [],
      operations: [],
      unsupported_intents: [],
      error: { code: "NO_MEDIA", message: "请先导入视频或音频素材。" },
    });
    return;
  }

  if (/卡通|换脸|补帧|对象移除|移除画面|高光|缺失动作/.test(prompt)) {
    emit({
      request_id: request.request_id,
      status: "partial",
      summary: "该请求包含当前版本不支持的生成式或自动识别能力，未生成伪造的可执行修改。",
      confidence: 0.54,
      requires_confirmation: true,
      warnings: [],
      operations: [],
      unsupported_intents: [
        {
          intent: "生成式视频重绘/自动内容理解",
          reason: "P0/P3 当前版本只支持剪辑、字幕、音频和基础画面参数，不能换脸、补帧、移除对象或自动识别高光。",
        },
      ],
    });
    return;
  }

  const operations = [];
  const audioTracks = request.context.audio?.tracks ?? [];
  const clips = request.context.clips ?? [];
  const firstAudioClip = clips.find((clip) => clip.kind === "audio");
  const firstVideoClip = clips.find((clip) => clip.kind === "video");
  const voiceTrack = audioTracks.find((track) => track.role === "voice");
  const musicTrack = audioTracks.find((track) => track.role === "music");
  const mixedTrack = audioTracks.find((track) => track.role === "mixed");
  const speechSegments = request.context.audio?.analysis?.speech_segments ?? [{ start_ms: 1000, end_ms: 7000, confidence: 0.9 }];
  const range = prompt.match(/(\d+)\s*(?:到|-|~)\s*(\d+)\s*秒?/);
  const isDeleteIntent = /删除|删掉|剪掉|开头|空白|片尾|最后|前\s*\d/.test(prompt);

  if (/duck|压低|盖住|恢复|背景音乐.*(?:小|低)|配乐.*(?:小|低)/.test(prompt)) {
    if (voiceTrack && musicTrack) {
      operations.push({
        id: "op_duck_music",
        type: "duck_music",
        target: { voice_track_id: voiceTrack.track_id, music_track_id: musicTrack.track_id },
        params: { duck_db: -9, attack_ms: 120, release_ms: 650, segments: speechSegments },
        rationale: "在人声出现时压低配乐，讲话结束后平滑恢复。",
      });
    } else {
      emit({
        ...base,
        status: "partial",
        summary: "已理解配乐闪避意图，但需要先选择人声轨和配乐轨。",
        operations: mixedTrack ? [{
          id: "op_review_mixed_track_ducking",
          type: "mark_review_range",
          target: { track_id: "ai_markers", start_ms: 1000, end_ms: Math.min(5200, request.project.duration_ms) },
          params: { reason_code: "MEDIA_UNSUPPORTED_SEMANTIC", suggested_action: "混合音轨无法可靠分离人声和配乐，请拆分为 voice/music 轨后再执行 ducking。" },
          rationale: "标记需要人工拆轨确认的混合音轨范围，避免伪造配乐闪避结果。",
        }] : [],
        warnings: [{ code: "TRACK_ROLE_UNKNOWN", message: "请选择 voice/music 轨道后重试。" }],
      });
      return;
    }
  }
  if (/降噪|底噪|噪声|噪音|电流声|风噪|清楚/.test(prompt) && firstAudioClip) {
    operations.push({
      id: "op_reduce_noise",
      type: "reduce_noise",
      target: { track_id: voiceTrack?.track_id, clip_id: firstAudioClip.id },
      params: { strength: 0.45, noise_profile: "auto", preserve_voice: true, target_noise_floor_dbfs: -50 },
      rationale: "降低稳定背景噪声并保留人声可懂度。",
    });
  }
  if (!operations.some((operation) => operation.type === "reduce_noise") && /音量|忽大忽小|爆音|响度|统一|稳定|短视频|适合/.test(prompt)) {
    operations.push({
      id: "op_equalize_loudness",
      type: "equalize_loudness",
      target: { track_id: voiceTrack?.track_id, clip_id: firstAudioClip?.id },
      params: { target_lufs: -16, max_gain_db: 6, limit_peak_dbfs: -1, scope_mode: "track" },
      rationale: "统一人声响度并限制峰值，降低削波风险。",
    });
  }
  if (/静音|不要声音|关掉/.test(prompt)) {
    operations.push({
      id: "op_mute_range",
      type: "mute_range",
      target: { track_id: voiceTrack?.track_id, start_ms: range ? Number(range[1]) * 1000 : 1000, end_ms: range ? Number(range[2]) * 1000 : Math.min(5200, request.project.duration_ms) },
      params: { ramp_ms: 80, preserve_video: true },
      rationale: "静音指定音频范围，画面和时间线长度保持不变。",
    });
  }
  if (/淡入|淡出|不要突然断|结尾/.test(prompt) && firstAudioClip) {
    operations.push({
      id: "op_audio_fade",
      type: "apply_audio_fade",
      target: { clip_id: firstAudioClip.id, track_id: /配乐|音乐/.test(prompt) ? musicTrack?.track_id : voiceTrack?.track_id },
      params: { fade_type: /淡入/.test(prompt) && !/淡出|结尾/.test(prompt) ? "in" : "out", duration_ms: 1200, curve: "equal_power" },
      rationale: "对音频片段添加平滑淡入淡出，不作用于视频轨。",
    });
  }
  if (/亮|自然|肤色|润色|明亮|对比度|饱和度/.test(prompt) && firstVideoClip) {
    operations.push({
      id: "op_video_polish",
      type: "adjust_video",
      target: { clip_id: firstVideoClip.id },
      params: { brightness: /亮|明亮/.test(prompt) ? 0.08 : undefined, contrast: /对比度|自然|肤色/.test(prompt) ? 0.05 : undefined, saturation: /饱和度|自然|肤色/.test(prompt) ? 0.04 : undefined },
      rationale: "轻度提升画面亮度、对比度或饱和度。",
    });
  }
  if (!isDeleteIntent && !operations.some((operation) => ["reduce_noise", "duck_music", "mute_range", "apply_audio_fade", "shift_audio"].includes(operation.type)) && /人声|声音|音频|增强|音量/.test(prompt) && firstAudioClip) {
    operations.push({
      id: "op_audio_enhance",
      type: "adjust_audio",
      target: { clip_id: firstAudioClip.id },
      params: { normalize: true, volume_db: 2 },
      rationale: "根据 Prompt 调整音频响度。",
    });
  }

  if (operations.length > 0 && !isDeleteIntent) {
    emit({
      ...base,
      status: "succeeded",
      summary: `已生成 ${operations.length} 个可审阅操作：剪辑、字幕、音频滤镜或基础润色参数。`,
      operations,
    });
    return;
  }

  const intro = prompt.match(/开头\s*(\d+)\s*秒|(\d+)\s*秒.*开头|前\s*(\d+)\s*秒/)?.slice(1).find(Boolean);
  if ((range && /删除|删掉|剪掉/.test(prompt)) || /开头|空白|片尾|最后|前\s*\d/.test(prompt)) {
    operations.push({
      id: "op_delete_range",
      type: "delete_range",
      target: range ? { start_ms: Number(range[1]) * 1000, end_ms: Number(range[2]) * 1000 } : { start_ms: 0, end_ms: Number(intro ?? 3) * 1000 },
      params: { ripple: true },
      rationale: "根据 Prompt 删除指定时间范围并波纹前移。",
    });
  }
  if (/人声|降噪|噪声|声音|音频|增强|静音|淡入|淡出|音量/.test(prompt)) {
    operations.push({
      id: "op_audio_enhance",
      type: "adjust_audio",
      target: { clip_id: "audio_bed" },
      params: { normalize: true, volume_db: 2 },
      rationale: "根据 Prompt 调整音频响度、静音或淡入淡出。",
    });
  }

  emit({
    ...base,
    status: "succeeded",
    summary: `已生成 ${operations.length} 个可审阅操作：剪辑、字幕或基础润色参数。`,
    operations,
  });
});
