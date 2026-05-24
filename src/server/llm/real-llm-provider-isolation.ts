import { z } from "zod";

export const RealLlmSemanticProviderSchema = z.enum(["mock", "codex-cli"]);
export type RealLlmSemanticProvider = z.infer<typeof RealLlmSemanticProviderSchema>;

export const REAL_LLM_SECRET_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
] as const;

const ALLOWED_CHILD_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TERM", "CODEX_HOME", "CODEX_CLI_TIMEOUT_MS"] as const;

export const assertNoRealLlmSecrets = (env: NodeJS.ProcessEnv | Record<string, string | undefined>): void => {
  const present = REAL_LLM_SECRET_ENV_KEYS.filter((key) => Boolean(env[key]));
  if (present.length > 0) {
    throw new Error(`REAL_LLM_SECRET_PRESENT:${present.join(",")}`);
  }
};

export const sanitizedProviderEnv = (env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string | undefined> => {
  assertNoRealLlmSecrets(env);
  return Object.fromEntries(ALLOWED_CHILD_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))) as Record<string, string | undefined>;
};

export const redactLlmSemanticLog = (text: string): string =>
  text
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|COOKIE|AUTHORIZATION)[A-Za-z0-9_]*\s*=\s*[^,\s"]+)/gi, "[REDACTED_SECRET]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED_SECRET]")
    .replace(/\/home\/[^/\s"']+/g, "[REDACTED_HOME]")
    .slice(0, 2048);

