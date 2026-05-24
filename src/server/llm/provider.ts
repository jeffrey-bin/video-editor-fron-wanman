import { generateCodexCliEditPlan, type CodexCliOptions } from "@/server/llm/codex-cli-provider";
import type { EditPlanResponse, LlmEditRequest } from "@/server/llm/edit-plan-protocol";
import { generateMockEditPlan } from "@/server/llm/mock-provider";

export type LlmProviderName = "mock" | "codex-cli";

type ProviderEnv = Record<string, string | undefined>;

export type LlmProviderOptions = {
  env?: ProviderEnv;
  codexCli?: CodexCliOptions;
  providers?: {
    mock?: (input: LlmEditRequest) => Promise<EditPlanResponse>;
    codexCli?: (input: LlmEditRequest, options?: CodexCliOptions) => Promise<EditPlanResponse>;
  };
};

export class LlmProviderError extends Error {
  constructor(
    public code: "LLM_PROVIDER_UNSUPPORTED",
    message: string,
  ) {
    super(message);
  }
}

export const selectLlmProvider = (env: ProviderEnv = process.env): LlmProviderName => {
  const provider = env.LLM_PROVIDER ?? "mock";
  if (provider === "mock" || provider === "codex-cli") return provider;
  throw new LlmProviderError("LLM_PROVIDER_UNSUPPORTED", `Unsupported LLM_PROVIDER: ${provider}`);
};

export const generateConfiguredEditPlan = async (input: LlmEditRequest, options: LlmProviderOptions = {}): Promise<EditPlanResponse> => {
  const provider = selectLlmProvider(options.env);
  if (provider === "codex-cli") {
    return (options.providers?.codexCli ?? generateCodexCliEditPlan)(input, options.codexCli);
  }
  return (options.providers?.mock ?? generateMockEditPlan)(input);
};
