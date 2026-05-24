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
  operationTypes: plan.operations.map((operation) => operation.type),
  unsupportedIntents: plan.unsupported_intents.map((intent) => intent.intent).sort(),
  requiresConfirmation: plan.requires_confirmation,
});

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
      const hardFailure = reasons.some((reason) => reason.includes("schema") || reason.includes("dry-run") || reason.includes("超出 available_operations") || reason.includes("failed 仍返回"));
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
