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
  const range = prompt.match(/(\d+)\s*(?:到|-|~)\s*(\d+)\s*秒?/);
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
