import { describe, expect, it } from "vitest";
import { assertNoRealLlmSecrets, RealLlmSemanticProviderSchema, redactLlmSemanticLog, sanitizedProviderEnv } from "@/server/llm/real-llm-provider-isolation";

describe("real LLM provider isolation", () => {
  it("rejects real provider secrets before runner or provider execution", () => {
    expect(() => assertNoRealLlmSecrets({ OPENAI_API_KEY: "sk-test-secret" })).toThrow("REAL_LLM_SECRET_PRESENT:OPENAI_API_KEY");
    expect(() => assertNoRealLlmSecrets({ PATH: "/bin" })).not.toThrow();
  });

  it("allowlists child process environment without leaking API keys", () => {
    expect(sanitizedProviderEnv({ PATH: "/bin", LANG: "C", HOME: "/home/user", CODEX_HOME: "/tmp/codex", CODEX_CLI_TIMEOUT_MS: "5" })).toEqual({
      PATH: "/bin",
      LANG: "C",
      CODEX_HOME: "/tmp/codex",
      CODEX_CLI_TIMEOUT_MS: "5",
    });
    expect(() => sanitizedProviderEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "secret-value" })).toThrow("REAL_LLM_SECRET_PRESENT");
  });

  it("redacts keys, bearer tokens, and home paths from logs", () => {
    const redacted = redactLlmSemanticLog("OPENAI_API_KEY=sk-12345678901234567890 Bearer abc.def /home/alice/project");
    expect(redacted).not.toContain("sk-123");
    expect(redacted).not.toContain("abc.def");
    expect(redacted).not.toContain("/home/alice");
    expect(redacted).toContain("[REDACTED_SECRET]");
  });

  it("allows only mock and codex-cli providers for this gate", () => {
    expect(RealLlmSemanticProviderSchema.safeParse("mock").success).toBe(true);
    expect(RealLlmSemanticProviderSchema.safeParse("codex-cli").success).toBe(true);
    expect(RealLlmSemanticProviderSchema.safeParse("openai").success).toBe(false);
  });
});

