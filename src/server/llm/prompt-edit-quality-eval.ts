import { dryRunEditPlan } from "@/server/editor/timeline-ops";
import { EditPlanResponseSchema, LlmEditRequestSchema, type EditPlanResponse, type LlmEditRequest } from "@/server/llm/edit-plan-protocol";
import { buildPromptQualityRequest, PROMPT_EDIT_QUALITY_CASES, promptQualityTimeline, type PromptQualityCase, type PromptQualityCategory } from "@/server/llm/prompt-edit-quality-corpus";
import type { OperationType } from "@/server/editor/operation-schema";

export type PromptQualityProvider = (input: LlmEditRequest) => Promise<EditPlanResponse>;

export type PromptQualityCaseResult = {
  case_id: string;
  category: PromptQualityCategory;
  passed: boolean;
  hard_failure: boolean;
  score: number;
  reasons: string[];
  operation_types: OperationType[];
};

export type PromptQualityRunResult = {
  run_id: string;
  provider: string;
  total_cases: number;
  passed_cases: number;
  hard_failures: number;
  average_score: number;
  category_scores: Record<PromptQualityCategory, number>;
  failures: Array<{ case_id: string; reason: string; severity: "low" | "medium" | "high" }>;
  case_results: PromptQualityCaseResult[];
};

export const normalizePlan = (plan: EditPlanResponse) => ({
  status: plan.status,
  operations: plan.operations.map((operation) => ({ type: operation.type, target: operation.target, params: operation.params })),
  unsupportedIntents: plan.unsupported_intents.map((intent) => intent.intent).sort(),
  unsupportedReasons: plan.unsupported_intents.map((intent) => intent.reason).sort(),
  warningCodes: plan.warnings.map((warning) => warning.code).sort(),
  errorCode: plan.error?.code,
  requiresConfirmation: plan.requires_confirmation,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const matchesPartial = (actual: unknown, expected: unknown): boolean => {
  if (expected === undefined) return true;
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => matchesPartial(actual[key], value));
  }
  return actual === expected;
};

const operationWithinScope = (operation: EditPlanResponse["operations"][number], request: LlmEditRequest) => {
  const scope = request.user_intent.scope;
  if (scope.type === "clip" && "clip_id" in operation.target) return scope.clip_ids.includes(operation.target.clip_id);
  if (scope.type === "subtitle" && "subtitle_id" in operation.target && scope.subtitle_ids) return scope.subtitle_ids.includes(operation.target.subtitle_id);
  if (scope.type === "selection") {
    if (operation.type === "delete_range") return operation.target.start_ms >= scope.start_ms && operation.target.end_ms <= scope.end_ms;
    if (operation.type === "add_subtitle") return operation.params.start_ms >= scope.start_ms && operation.params.end_ms <= scope.end_ms;
  }
  return true;
};

const applyStructuredAssertions = (qualityCase: PromptQualityCase, request: LlmEditRequest, plan: EditPlanResponse, reasons: string[]) => {
  const assertions = qualityCase.assertions;
  let penalty = 0;
  if (assertions.require_timeline_version_match && request.project.timeline_version !== (qualityCase.timeline ?? promptQualityTimeline()).version && plan.status === "succeeded") {
    reasons.push("timeline_version 旧版本请求不得直接 succeeded");
    penalty += 40;
  }
  if (assertions.max_operations !== undefined && plan.operations.length > assertions.max_operations) {
    reasons.push(`operation 数量超过 max_operations: ${plan.operations.length} > ${assertions.max_operations}`);
    penalty += 30;
  }
  if (assertions.no_operations && plan.operations.length > 0) {
    reasons.push("负向样例不应返回 operations");
    penalty += 35;
  }
  const unsupportedReasonIncludes = assertions.unsupported_reason_includes;
  if (unsupportedReasonIncludes) {
    if (!plan.unsupported_intents.some((intent) => intent.reason.includes(unsupportedReasonIncludes))) {
      reasons.push(`unsupported reason 未包含: ${unsupportedReasonIncludes}`);
      penalty += 25;
    }
  }
  for (const code of assertions.warning_codes ?? []) {
    if (!plan.warnings.some((warning) => warning.code === code)) {
      reasons.push(`缺少 warning code: ${code}`);
      penalty += 15;
    }
  }
  if (assertions.error_code && plan.error?.code !== assertions.error_code) {
    reasons.push(`error code=${plan.error?.code ?? "none"} 不符合预期 ${assertions.error_code}`);
    penalty += 25;
  }
  for (const assertion of assertions.operations ?? []) {
    const operation = plan.operations.find((candidate) => candidate.type === assertion.type && matchesPartial(candidate.target, assertion.target) && matchesPartial(candidate.params, assertion.params));
    if (!operation) {
      reasons.push(`关键断言失败: ${assertion.type} target/params 不符合预期`);
      penalty += 30;
      continue;
    }
    if (assertion.within_scope && !operationWithinScope(operation, request)) {
      reasons.push(`关键断言失败: ${assertion.type} 超出 request scope`);
      penalty += 30;
    }
  }
  return penalty;
};

const scoreCase = (qualityCase: PromptQualityCase, request: LlmEditRequest, plan: EditPlanResponse) => {
  const reasons: string[] = [];
  let score = 100;
  const operationTypes = plan.operations.map((operation) => operation.type);
  const timeline = qualityCase.timeline ?? promptQualityTimeline();

  if (plan.request_id !== request.request_id) {
    reasons.push("request_id 未原样返回");
    score -= 20;
  }
  if (!qualityCase.expected_status.includes(plan.status)) {
    reasons.push(`status=${plan.status} 不符合预期 ${qualityCase.expected_status.join("|")}`);
    score -= 25;
  }
  for (const expected of qualityCase.expected_operations) {
    if (!operationTypes.includes(expected)) {
      reasons.push(`缺少期望 operation: ${expected}`);
      score -= 12;
    }
  }
  for (const forbidden of qualityCase.forbidden_operations ?? []) {
    if (operationTypes.includes(forbidden)) {
      reasons.push(`包含禁止 operation: ${forbidden}`);
      score -= 25;
    }
  }
  for (const operation of plan.operations) {
    if (!request.context.available_operations.includes(operation.type)) {
      reasons.push(`operation 超出 available_operations: ${operation.type}`);
      score -= 30;
    }
  }
  score -= applyStructuredAssertions(qualityCase, request, plan, reasons);
  if ((qualityCase.risk === "high" || plan.confidence < 0.6) && !plan.requires_confirmation) {
    reasons.push("高风险或低置信度计划未要求确认");
    score -= 20;
  }
  if (plan.status === "partial" && plan.warnings.length === 0 && plan.unsupported_intents.length === 0) {
    reasons.push("partial 未解释 warnings/unsupported_intents");
    score -= 20;
  }
  if (plan.status === "failed" && plan.operations.length > 0) {
    reasons.push("failed 仍返回 operations");
    score -= 40;
  }
  if (plan.status !== "failed" && plan.operations.length > 0) {
    try {
      dryRunEditPlan(timeline, plan.operations);
    } catch (error) {
      reasons.push(`dry-run 时间线安全失败: ${error instanceof Error ? error.message : String(error)}`);
      score -= 40;
    }
  }
  return { score: Math.max(0, score), reasons, operationTypes };
};

export const evaluatePromptQualityProvider = async (
  providerName: string,
  provider: PromptQualityProvider,
  cases: PromptQualityCase[] = PROMPT_EDIT_QUALITY_CASES,
): Promise<PromptQualityRunResult> => {
  const caseResults: PromptQualityCaseResult[] = [];
  for (const qualityCase of cases) {
    const request = buildPromptQualityRequest(qualityCase);
    const requestValid = LlmEditRequestSchema.safeParse(request);
    if (!requestValid.success) {
      caseResults.push({ case_id: qualityCase.case_id, category: qualityCase.category, passed: false, hard_failure: true, score: 0, reasons: ["fixture request schema invalid"], operation_types: [] });
      continue;
    }
    try {
      const plan = await provider(request);
      const parsed = EditPlanResponseSchema.safeParse(plan);
      if (!parsed.success) {
        caseResults.push({ case_id: qualityCase.case_id, category: qualityCase.category, passed: false, hard_failure: true, score: 0, reasons: ["provider response schema invalid"], operation_types: [] });
        continue;
      }
      const { score, reasons, operationTypes } = scoreCase(qualityCase, request, parsed.data);
      const hardFailure = reasons.some((reason) => reason.includes("schema") || reason.includes("dry-run") || reason.includes("超出 available_operations") || reason.includes("failed 仍返回") || reason.includes("关键断言失败") || reason.includes("timeline_version"));
      caseResults.push({ case_id: qualityCase.case_id, category: qualityCase.category, passed: score >= 80 && !hardFailure, hard_failure: hardFailure, score, reasons, operation_types: operationTypes });
    } catch (error) {
      caseResults.push({ case_id: qualityCase.case_id, category: qualityCase.category, passed: false, hard_failure: true, score: 0, reasons: [error instanceof Error ? error.message : String(error)], operation_types: [] });
    }
  }

  const categories = [...new Set(cases.map((qualityCase) => qualityCase.category))] as PromptQualityCategory[];
  const categoryScores = Object.fromEntries(
    categories.map((category) => {
      const results = caseResults.filter((result) => result.category === category);
      return [category, Number((results.reduce((sum, result) => sum + result.score, 0) / results.length).toFixed(1))];
    }),
  ) as Record<PromptQualityCategory, number>;
  const averageScore = Number((caseResults.reduce((sum, result) => sum + result.score, 0) / caseResults.length).toFixed(1));
  return {
    run_id: `prompt-edit-quality-${new Date(0).toISOString()}`,
    provider: providerName,
    total_cases: caseResults.length,
    passed_cases: caseResults.filter((result) => result.passed).length,
    hard_failures: caseResults.filter((result) => result.hard_failure).length,
    average_score: averageScore,
    category_scores: categoryScores,
    failures: caseResults
      .filter((result) => !result.passed)
      .map((result) => ({ case_id: result.case_id, reason: result.reasons.join("; "), severity: result.hard_failure ? "high" : "medium" })),
    case_results: caseResults,
  };
};
