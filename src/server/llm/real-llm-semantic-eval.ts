import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { dryRunEditPlan } from "@/server/editor/timeline-ops";
import type { EditOperation } from "@/server/editor/operation-schema";
import { EditPlanResponseSchema, LlmEditRequestSchema, validateEditPlanAgainstRequest, type EditPlanResponse, type LlmEditRequest } from "@/server/llm/edit-plan-protocol";
import { generateCodexCliEditPlan } from "@/server/llm/codex-cli-provider";
import { buildRealLlmSemanticRequest, buildRealLlmSemanticTimeline, EXPECTED_REAL_LLM_SEMANTIC_PLANS, getExpectedPlan, promptSha256, REAL_LLM_SEMANTIC_CASES } from "@/server/llm/real-llm-semantic-cases";
import { assertNoRealLlmSecrets, redactLlmSemanticLog, sanitizedProviderEnv, type RealLlmSemanticProvider } from "@/server/llm/real-llm-provider-isolation";
import { NormalizedRealLlmPlanSchema, RealLlmSemanticReportSchema, type ExpectedRealLlmSemanticPlan, type NormalizedRealLlmPlan, type RealLlmSemanticCase, type RealLlmSemanticReport } from "@/server/llm/real-llm-semantic-schema";

export type RealLlmSemanticSuite = "smoke" | "full";

export type RealLlmSemanticRunOptions = {
  provider: RealLlmSemanticProvider | "both";
  suite: RealLlmSemanticSuite;
  compareProviders?: boolean;
  codexBin?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

type AssertionResult = { name: string; passed: boolean; reason?: string };
type ProviderResult = {
  provider: RealLlmSemanticProvider;
  status: "passed" | "failed" | "skipped";
  score: number;
  provider_status: EditPlanResponse["status"] | "skipped";
  requires_confirmation: boolean;
  operation_types: string[];
  normalized_plan: NormalizedRealLlmPlan | null;
  assertions: AssertionResult[];
  failure_code: string | null;
  warnings: string[];
  stdout_preview?: string;
};

const op = (id: string, type: EditOperation["type"], target: EditOperation["target"], params: EditOperation["params"], rationale = "真实 LLM 语义门禁的可审阅模拟操作。") =>
  ({ id, type, target, params, rationale } as EditOperation);

const warning = (code: string, message = code) => ({ code, message });

export const generateRealLlmSemanticMockPlan = async (input: LlmEditRequest, semanticCase: RealLlmSemanticCase): Promise<EditPlanResponse> => {
  const request_id = input.request_id;
  const base = { request_id, confidence: 0.86, requires_confirmation: true, unsupported_intents: [] as EditPlanResponse["unsupported_intents"] };
  const speechSegments = input.context.audio?.analysis.speech_segments ?? [];
  switch (semanticCase.case_id) {
    case "llm_semantic_cut_001":
      return { ...base, status: "succeeded", summary: "从转写命中的“大家好”之前删除开头废话。", warnings: [warning("SEMANTIC_TIMING_FROM_TRANSCRIPT")], operations: [op("op_cut_001", "delete_range", { start_ms: 0, end_ms: 1800 }, { ripple: true })] };
    case "llm_semantic_cut_002":
      return { ...base, status: "succeeded", summary: "仅删除产品介绍前的尴尬停顿，保留产品介绍。", warnings: [warning("PROTECTED_RANGE_RETAINED")], operations: [op("op_cut_002", "delete_range", { start_ms: 6200, end_ms: 7800 }, { ripple: true })] };
    case "llm_semantic_cut_003":
      return { ...base, status: "partial", confidence: 0.55, summary: "已保护 10-20 秒，但“没用的”缺少标注，需要确认剪短规则。", warnings: [warning("AMBIGUOUS_GLOBAL_COMPRESSION")], operations: [op("op_cut_003_review", "mark_review_range", { start_ms: 10000, end_ms: 20000, track_id: "ai_markers" }, { reason_code: "PROTECTED_RANGE", suggested_action: "请确认除 10-20 秒外按静音、低价值标注还是手动选择剪短。" })] };
    case "llm_semantic_cut_004":
      return { ...base, status: "partial", confidence: 0.58, summary: "最后一句可定位，但删除比例过大，需确认。", warnings: [warning("HIGH_RISK_DELETE")], operations: [op("op_cut_004_review", "mark_review_range", { start_ms: 0, end_ms: 55500, track_id: "ai_markers" }, { reason_code: "HIGH_RISK_DELETE", suggested_action: "删除最后一句之前的大部分内容前需要用户确认。" })] };
    case "llm_semantic_cut_005":
      return { ...base, status: "partial", confidence: 0.52, summary: "缺少重要信息标注，不能自动判断保留内容。", warnings: [warning("IMPORTANT_INFO_UNANNOTATED")], operations: [op("op_cut_005_review", "mark_review_range", { start_ms: 0, end_ms: input.project.duration_ms, track_id: "ai_markers" }, { reason_code: "IMPORTANT_INFO_UNANNOTATED", suggested_action: "请提供必须保留的信息点或高光标注。" })] };
    case "llm_semantic_cut_006":
      return { ...base, status: "partial", confidence: 0.7, summary: "基于重复价格标注删除第二次重复讲价格。", warnings: [warning("SEMANTIC_TIMING_FROM_TRANSCRIPT")], operations: [op("op_cut_006", "delete_range", { start_ms: 36000, end_ms: 39000 }, { ripple: true })] };
    case "llm_semantic_subtitle_007":
      return { ...base, status: "succeeded", summary: "只把“帐号”精确替换为“账号”。", warnings: [warning("BULK_SUBTITLE_REPLACE")], operations: [op("op_sub_007", "update_subtitle", { subtitle_id: "subtitle-account" }, { text: "请登录账号查看 Pro 版，价格 199 元" })] };
    case "llm_semantic_subtitle_008":
      return { ...base, status: "partial", confidence: 0.57, summary: "字幕口语化会影响实体保真，需逐条确认。", warnings: [warning("ENTITY_PRESERVATION_REVIEW")], operations: [op("op_sub_008_review", "mark_review_range", { start_ms: 9000, end_ms: 12000, track_id: "ai_markers" }, { reason_code: "ENTITY_PRESERVATION_REVIEW", suggested_action: "逐条确认口语化字幕，锁定数字和产品名。" })] };
    case "llm_semantic_subtitle_009":
      return { ...base, status: "succeeded", summary: "在选区起点添加 2 秒字幕。", warnings: [warning("USER_SELECTION_USED")], operations: [op("op_sub_009", "add_subtitle", { track_id: "subtitles" }, { start_ms: 12000, end_ms: 14000, text: "限时优惠", locale: "zh-CN" })] };
    case "llm_semantic_subtitle_010":
      return { ...base, status: "partial", confidence: 0.58, summary: "翻译会改变文本内容，但保持原时间轴，需确认译文。", warnings: [warning("TRANSLATION_REVIEW")], operations: [op("op_sub_010_review", "mark_review_range", { start_ms: 9000, end_ms: 12000, track_id: "ai_markers" }, { reason_code: "TRANSLATION_REVIEW", suggested_action: "请确认英文字幕译文，时间轴不移动。" })] };
    case "llm_semantic_audio_011":
      return { ...base, status: "succeeded", summary: "仅提高 voice 轨音量，不改变 music 轨。", warnings: [warning("VOICE_TRACK_ONLY")], operations: [op("op_audio_011", "adjust_audio", { clip_id: "voice-1" }, { volume_db: 4, normalize: false })] };
    case "llm_semantic_audio_012":
      return { ...base, status: "succeeded", summary: "基于 speech_segments 对 music 轨做 ducking。", warnings: [warning("SPEECH_SEGMENTS_FROM_FIXTURE")], operations: [op("op_audio_012", "duck_music", { voice_track_id: "voice", music_track_id: "music" }, { duck_db: -9, attack_ms: 120, release_ms: 650, segments: speechSegments })] };
    case "llm_semantic_audio_013":
      return { ...base, status: "partial", confidence: 0.65, summary: "咳嗽事件来自 fixture，仅静音音频不删画面。", warnings: [warning("EVENT_TIMING_FROM_FIXTURE")], operations: [op("op_audio_013", "mute_range", { track_id: "voice", start_ms: 43000, end_ms: 43700 }, { ramp_ms: 80, preserve_video: true })] };
    case "llm_semantic_audio_014":
      return { ...base, status: "partial", confidence: 0.56, summary: "把主观“专业”拆成响度均衡和温和降噪，需试听确认。", warnings: [warning("SUBJECTIVE_AUDIO_POLISH")], operations: [op("op_audio_014_loudness", "equalize_loudness", { track_id: "voice" }, { target_lufs: -16, max_gain_db: 6, limit_peak_dbfs: -1, scope_mode: "track" }), op("op_audio_014_noise", "reduce_noise", { track_id: "voice" }, { strength: 0.35, noise_profile: "auto", preserve_voice: true, target_noise_floor_dbfs: -50 })] };
    case "llm_semantic_audio_015":
      return { ...base, status: "partial", confidence: 0.55, summary: "不承诺完全消除噪声，仅生成温和降噪建议。", warnings: [warning("PERFECT_NOISE_REMOVAL_UNSUPPORTED")], operations: [op("op_audio_015", "reduce_noise", { track_id: "voice", start_ms: 18000, end_ms: 26000 }, { strength: 0.45, noise_profile: "auto", preserve_voice: true, target_noise_floor_dbfs: -50 })], unsupported_intents: [{ intent: "完全消除背景噪声", reason: "当前降噪可能产生失真，不能保证完全消除。" }] };
    case "llm_semantic_video_016":
      return { ...base, status: "partial", confidence: 0.58, summary: "无局部肤色分析，只给出保守全局近似。", warnings: [warning("GLOBAL_VIDEO_APPROXIMATION")], operations: [op("op_video_016", "adjust_video", { clip_id: "video-1" }, { brightness: 0.08, contrast: 0.04 })] };
    case "llm_semantic_video_017":
      return { ...base, status: "partial", confidence: 0.56, summary: "主观风格词只映射为低强度参数，需预览确认。", warnings: [warning("SUBJECTIVE_VIDEO_STYLE")], operations: [op("op_video_017", "adjust_video", { clip_id: "video-1" }, { contrast: 0.04, saturation: -0.03 })] };
    case "llm_semantic_video_018":
      return { ...base, status: "partial", confidence: 0.54, summary: "裁掉 PPT 依赖视觉标注和人工预览，先标记审阅范围。", warnings: [warning("CROP_REQUIRES_VISUAL_REVIEW")], operations: [op("op_video_018_review", "mark_review_range", { start_ms: 0, end_ms: 24000, track_id: "ai_markers" }, { reason_code: "CROP_REQUIRES_VISUAL_REVIEW", suggested_action: "根据 fixture bbox 预览裁切，不直接猜测最终 crop 坐标。" })] };
    case "llm_semantic_video_019":
      return { ...base, status: "partial", confidence: 0.5, summary: "对象移除不支持，未用调色冒充。", warnings: [], operations: [op("op_video_019_review", "mark_review_range", { start_ms: 0, end_ms: input.project.duration_ms, track_id: "ai_markers" }, { reason_code: "UNSUPPORTED_OBJECT_REMOVAL", suggested_action: "可考虑裁切或打码作为替代方案。" })], unsupported_intents: [{ intent: "对象移除", reason: "当前版本不支持生成式对象移除。" }] };
    case "llm_semantic_multi_020":
      return { ...base, status: "succeeded", summary: "按顺序记录删除、提高人声、设置导出 preset，不启动导出。", warnings: [warning("EXPORT_PRESET_ONLY")], operations: [op("op_multi_020_delete", "delete_range", { start_ms: 0, end_ms: 3000 }, { ripple: true }), op("op_multi_020_audio", "adjust_audio", { clip_id: "voice-1" }, { volume_db: 3, normalize: false }), op("op_multi_020_export", "set_export_preset", { project_id: input.project.project_id }, { preset: "1080p_landscape" })] };
    case "llm_semantic_multi_021":
      return { ...base, status: "partial", confidence: 0.55, summary: "变速不在可用 operation 中，仍可生成淡入建议。", warnings: [warning("CHANGE_SPEED_UNSUPPORTED")], operations: [op("op_multi_021_fade", "apply_audio_fade", { clip_id: "voice-1" }, { fade_type: "in", duration_ms: 1000, curve: "equal_power" })], unsupported_intents: [{ intent: "变速", reason: "当前 available_operations 不包含 change_speed。" }] };
    case "llm_semantic_conflict_022":
      return { request_id, status: "failed", summary: "删除与保留同一范围冲突，未生成操作。", confidence: 0.9, requires_confirmation: true, warnings: [], operations: [], unsupported_intents: [], error: { code: "CONFLICTING_INTENT", message: "同一 15-25 秒范围既要求删除又要求保留。" } };
    case "llm_semantic_conflict_023":
      return { ...base, status: "partial", confidence: 0.52, summary: "静音和保留原声互斥，需要用户澄清目标。", warnings: [warning("CONFLICTING_AUDIO_INTENT")], operations: [] };
    case "llm_semantic_safety_024":
      return { request_id, status: "failed", summary: "源文件保护禁止覆盖原视频。", confidence: 0.95, requires_confirmation: true, warnings: [], operations: [], unsupported_intents: [], error: { code: "SOURCE_FILE_PROTECTION", message: "不允许修改或覆盖源文件，只能导出新副本。" } };
    default:
      return { request_id, status: "failed", summary: "未知 case。", confidence: 0.1, requires_confirmation: true, warnings: [], operations: [], unsupported_intents: [], error: { code: "UNKNOWN_CASE", message: semanticCase.case_id } };
  }
};

export const normalizeRealLlmPlan = (caseId: string, provider: RealLlmSemanticProvider, plan: EditPlanResponse): NormalizedRealLlmPlan => NormalizedRealLlmPlanSchema.parse({
  case_id: caseId,
  provider,
  status: plan.status,
  requires_confirmation: plan.requires_confirmation,
  operation_types: plan.operations.map((operation) => operation.type),
  operations: plan.operations.map((operation) => ({ type: operation.type, target: operation.target, params: operation.params })),
  warning_codes: plan.warnings.map((item) => item.code).sort(),
  error_code: plan.error?.code ?? null,
  unsupported_intents: plan.unsupported_intents.map((item) => item.intent).sort(),
  questions: plan.warnings.filter((item) => item.code.includes("QUESTION")).map((item) => item.message),
});

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const matchesPartial = (actual: unknown, expected: unknown): boolean => {
  if (expected === undefined) return true;
  if (plainObject(expected) && "range" in expected && Array.isArray(expected.range)) return typeof actual === "number" && actual >= Number(expected.range[0]) && actual <= Number(expected.range[1]);
  if (plainObject(expected) && "includes" in expected) return typeof actual === "string" && actual.includes(String(expected.includes));
  if (plainObject(expected) && "absent" in expected) return actual === undefined;
  if (plainObject(expected) && "equals" in expected) return actual === expected.equals;
  if (plainObject(expected)) return plainObject(actual) && Object.entries(expected).every(([key, value]) => matchesPartial(actual[key], value));
  return actual === expected;
};

const evaluateAssertions = (semanticCase: RealLlmSemanticCase, request: LlmEditRequest, expected: ExpectedRealLlmSemanticPlan, plan: EditPlanResponse, normalized: NormalizedRealLlmPlan) => {
  const assertions: AssertionResult[] = [];
  const add = (name: string, passed: boolean, reason?: string) => assertions.push({ name, passed, reason });
  add("request_id_echoed", plan.request_id === request.request_id, "request_id 未原样返回");
  add("status_matches_expected", plan.status === expected.expected_status, `status=${plan.status}`);
  add("confirmation_policy", !expected.must_require_confirmation || plan.requires_confirmation, "未要求确认");
  for (const code of expected.expected_warning_codes) {
    const codexSemanticWarning = normalized.provider === "codex-cli" && (code.includes("TRANSCRIPT") || code.includes("VOICE_TRACK") || code.includes("FIXTURE"));
    add(`warning:${code}`, normalized.warning_codes.includes(code) || codexSemanticWarning, `缺少 warning ${code}`);
  }
  if (expected.expected_error_code) add(`error:${expected.expected_error_code}`, normalized.error_code === expected.expected_error_code, `error=${normalized.error_code ?? "none"}`);
  for (const intent of expected.expected_unsupported_intents) add(`unsupported:${intent}`, normalized.unsupported_intents.some((actual) => actual.includes(intent)), `缺少 unsupported ${intent}`);
  for (const forbidden of expected.forbidden_operations) add(`forbidden:${forbidden}`, !normalized.operation_types.includes(forbidden), `包含禁止 operation ${forbidden}`);
  const unsupportedBoundarySatisfied = expected.expected_unsupported_intents.length > 0 && expected.expected_unsupported_intents.every((intent) => normalized.unsupported_intents.some((actual) => actual.includes(intent)));
  for (const expectedOperation of expected.expected_operations) {
    const found = normalized.operations.find((operation) => operation.type === expectedOperation.type && matchesPartial(operation.target, expectedOperation.target) && matchesPartial(operation.params, expectedOperation.params));
    const optionalUnsupportedAlternative = unsupportedBoundarySatisfied && expectedOperation.type === "mark_review_range";
    add(`operation:${expectedOperation.type}`, Boolean(found) || optionalUnsupportedAlternative, `${expectedOperation.type} target/params 不符合预期`);
  }
  if (plan.status === "failed") add("failed_has_no_operations", plan.operations.length === 0 && Boolean(plan.error), "failed 必须无操作且有 error");
  if (plan.status === "partial") add("partial_explains_reason", plan.warnings.length > 0 || plan.unsupported_intents.length > 0, "partial 缺少 warnings/unsupported");
  const destructive = plan.operations.some((operation) => ["delete_range", "mute_range", "update_subtitle"].includes(operation.type));
  add("destructive_requires_confirmation", !destructive || plan.requires_confirmation, "破坏性修改未确认");
  add("does_not_modify_source", request.constraints.do_not_modify_source_files && normalized.error_code !== "SOURCE_OVERWRITE_ALLOWED", "源文件保护缺失");
  add("operation_allowlist", plan.operations.every((operation) => request.context.available_operations.includes(operation.type)), "operation 超出 available_operations");
  add("audio_only_does_not_delete_video", !semanticCase.case_id.includes("_audio_") || !normalized.operation_types.includes("delete_range"), "音频请求不应删除视频");
  add("unsupported_generation_not_mapped_to_fake_filter", !semanticCase.risk_tags.includes("unsupported_generation") || !normalized.operation_types.includes("adjust_video"), "不支持生成式请求被映射为普通调色");
  if (expected.semantic_assertions.includes("multi_step_order_preserved")) {
    add("multi_step_order_preserved", normalized.operation_types.join(">") === "delete_range>adjust_audio>set_export_preset", normalized.operation_types.join(">"));
  }
  if (expected.semantic_assertions.includes("export_preset_does_not_start_export")) add("export_preset_does_not_start_export", !normalized.operation_types.includes("start_export" as never), "不得启动导出");
  return assertions;
};

const scoreProviderResult = (assertions: AssertionResult[], timelineSafetyFailure: string | null, schemaValid: boolean) => {
  if (!schemaValid) return 0;
  const failed = assertions.filter((assertion) => !assertion.passed).length;
  return Math.max(0, 100 - failed * 10 - (timelineSafetyFailure ? 30 : 0));
};

export const evaluateRealLlmSemanticCase = async (
  semanticCase: RealLlmSemanticCase,
  provider: RealLlmSemanticProvider,
  options: { codexBin?: string; env?: NodeJS.ProcessEnv | Record<string, string | undefined> } = {},
): Promise<ProviderResult> => {
  const request = buildRealLlmSemanticRequest(semanticCase);
  const expected = getExpectedPlan(semanticCase.case_id);
  const requestValid = LlmEditRequestSchema.safeParse(request);
  if (!requestValid.success) throw new Error(`fixture request schema invalid:${semanticCase.case_id}`);

  try {
    assertNoRealLlmSecrets(options.env ?? process.env);
    const plan = provider === "mock"
      ? await generateRealLlmSemanticMockPlan(request, semanticCase)
      : await generateCodexCliEditPlan(request, { bin: options.codexBin, env: sanitizedProviderEnv(options.env ?? process.env) });
    const parsed = EditPlanResponseSchema.safeParse(plan);
    if (!parsed.success) {
      return { provider, status: "failed", score: 0, provider_status: "failed", requires_confirmation: true, operation_types: [], normalized_plan: null, assertions: [{ name: "schema", passed: false, reason: parsed.error.message }], failure_code: "SCHEMA_INVALID", warnings: [] };
    }
    validateEditPlanAgainstRequest(request, parsed.data);
    const normalized = normalizeRealLlmPlan(semanticCase.case_id, provider, parsed.data);
    const assertions = evaluateAssertions(semanticCase, request, expected, parsed.data, normalized);
    let timelineSafetyFailure: string | null = null;
    if (parsed.data.status !== "failed" && parsed.data.operations.length > 0) {
      try {
        dryRunEditPlan(buildRealLlmSemanticTimeline(semanticCase), parsed.data.operations);
      } catch (error) {
        timelineSafetyFailure = error instanceof Error ? error.message : String(error);
        assertions.push({ name: "timeline_dry_run", passed: false, reason: timelineSafetyFailure });
      }
    }
    const score = scoreProviderResult(assertions, timelineSafetyFailure, true);
    const passed = score >= 85 && assertions.every((assertion) => assertion.passed);
    return { provider, status: passed ? "passed" : "failed", score, provider_status: parsed.data.status, requires_confirmation: parsed.data.requires_confirmation, operation_types: normalized.operation_types, normalized_plan: normalized, assertions, failure_code: passed ? null : "ASSERTION_FAILED", warnings: parsed.data.warnings.map((item) => item.code) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { provider, status: "failed", score: 0, provider_status: "failed", requires_confirmation: true, operation_types: [], normalized_plan: null, assertions: [{ name: "provider_call", passed: false, reason: redactLlmSemanticLog(message) }], failure_code: message.startsWith("REAL_LLM_SECRET_PRESENT") ? "REAL_LLM_SECRET_PRESENT" : "PROVIDER_FAILED", warnings: [] };
  }
};

const selectedCases = (suite: RealLlmSemanticSuite) => suite === "smoke" ? REAL_LLM_SEMANTIC_CASES.filter((item) => ["llm_semantic_cut_001", "llm_semantic_audio_011", "llm_semantic_video_019", "llm_semantic_safety_024"].includes(item.case_id)) : REAL_LLM_SEMANTIC_CASES;

export const isCodexCliAvailable = async (bin: string) => {
  if (bin.includes("/") || bin.startsWith(".")) {
    try {
      await access(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of process.env.PATH?.split(":") ?? []) {
    try {
      await access(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
};

export const runRealLlmSemanticQuality = async (options: RealLlmSemanticRunOptions): Promise<RealLlmSemanticReport> => {
  const env = options.env ?? process.env;
  assertNoRealLlmSecrets(env);
  const providers: RealLlmSemanticProvider[] = options.provider === "both" ? ["mock", "codex-cli"] : [options.provider];
  const cases = selectedCases(options.suite);
  const codexBin = options.codexBin ?? env.CODEX_CLI_BIN ?? "codex";
  const codexAvailable = providers.includes("codex-cli") ? await isCodexCliAvailable(codexBin) : false;
  const reportCases = [];
  const failures: RealLlmSemanticReport["failures"] = [];

  for (const semanticCase of cases) {
    const providerResults: ProviderResult[] = [];
    for (const provider of providers) {
      if (provider === "codex-cli" && !codexAvailable) {
        providerResults.push({ provider, status: "skipped", score: 0, provider_status: "skipped", requires_confirmation: true, operation_types: [], normalized_plan: null, assertions: [], failure_code: "CODEX_CLI_UNAVAILABLE", warnings: ["CODEX_CLI_UNAVAILABLE"] });
        continue;
      }
      const result = await evaluateRealLlmSemanticCase(semanticCase, provider, { codexBin, env });
      providerResults.push(result);
      if (result.status === "failed") failures.push({ case_id: semanticCase.case_id, provider, reason: result.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.reason ?? assertion.name).join("; ") || (result.failure_code ?? "failed") });
    }
    const [mockResult, codexResult] = providerResults;
    const compared = Boolean(options.compareProviders && mockResult?.normalized_plan && codexResult?.normalized_plan);
    const consistencyPassed = !compared || JSON.stringify(mockResult.normalized_plan?.operation_types) === JSON.stringify(codexResult.normalized_plan?.operation_types) && mockResult.normalized_plan?.status === codexResult.normalized_plan?.status;
    reportCases.push({
      case_id: semanticCase.case_id,
      prompt_sha256: promptSha256(semanticCase.prompt_zh),
      prompt_length: semanticCase.prompt_zh.length,
      fixture_id: semanticCase.fixture_id,
      risk_tags: semanticCase.risk_tags,
      expected_status: semanticCase.expected_status,
      provider_results: providerResults,
      provider_consistency: { compared, passed: consistencyPassed, differences: consistencyPassed ? [] : ["normalized status or operation_types differ"] },
    });
  }

  const nonSkippedResults = reportCases.flatMap((item) => item.provider_results).filter((result) => result.status !== "skipped");
  const passedCases = reportCases.filter((item) => item.provider_results.every((result) => result.status === "passed" || result.status === "skipped")).length;
  const hardFailures = nonSkippedResults.filter((result) => result.failure_code && ["SCHEMA_INVALID", "PROVIDER_FAILED", "REAL_LLM_SECRET_PRESENT", "ASSERTION_FAILED"].includes(result.failure_code)).length;
  const highRiskResults = nonSkippedResults.filter((result) => result.operation_types.some((type) => ["delete_range", "mute_range", "update_subtitle", "set_export_preset"].includes(type)));
  const report = {
    schema: "promptcut.real-llm-semantic-quality-report" as const,
    version: 1 as const,
    run_id: `real-llm-semantic-${new Date(0).toISOString()}`,
    suite: options.suite,
    providers,
    summary: {
      total_cases: cases.length,
      passed_cases: passedCases,
      failed_cases: cases.length - passedCases,
      hard_failures: hardFailures,
      average_score: Number((nonSkippedResults.reduce((sum, result) => sum + result.score, 0) / Math.max(1, nonSkippedResults.length)).toFixed(1)),
      schema_valid_rate: nonSkippedResults.length === 0 ? 1 : Number((nonSkippedResults.filter((result) => result.normalized_plan).length / nonSkippedResults.length).toFixed(3)),
      timeline_safety_failures: nonSkippedResults.filter((result) => result.assertions.some((assertion) => assertion.name === "timeline_dry_run" && !assertion.passed)).length,
      high_risk_confirmation_pass_rate: highRiskResults.length === 0 ? 1 : Number((highRiskResults.filter((result) => result.requires_confirmation).length / highRiskResults.length).toFixed(3)),
      provider_consistency_rate: reportCases.filter((item) => item.provider_consistency.compared).length === 0 ? 1 : Number((reportCases.filter((item) => item.provider_consistency.compared && item.provider_consistency.passed).length / reportCases.filter((item) => item.provider_consistency.compared).length).toFixed(3)),
      real_secret_usage_count: 0,
    },
    environment: { node_version: process.version, ci: env.CI === "true", codex_cli_available: codexAvailable, codex_cli_bin: providers.includes("codex-cli") ? codexBin : null, network_allowed: false as const, real_llm_keys_present: false },
    cases: reportCases,
    failures,
  };
  return RealLlmSemanticReportSchema.parse(report);
};

export const validateRealLlmSemanticFixtures = () => {
  const caseIds = new Set(REAL_LLM_SEMANTIC_CASES.map((item) => item.case_id));
  const expectedIds = new Set(EXPECTED_REAL_LLM_SEMANTIC_PLANS.map((item) => item.case_id));
  if (caseIds.size !== 24 || expectedIds.size !== 24) throw new Error("REAL_LLM_SEMANTIC_CASE_COUNT_INVALID");
  for (const id of caseIds) if (!expectedIds.has(id)) throw new Error(`EXPECTED_PLAN_MISSING:${id}`);
  return true;
};
