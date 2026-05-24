import { describe, expect, it } from "vitest";
import { isCodexCliAvailable, runRealLlmSemanticQuality } from "@/server/llm/real-llm-semantic-eval";

describe("real LLM semantic runner behavior", () => {
  it("skips codex-cli when an explicit binary path is unavailable", async () => {
    await expect(isCodexCliAvailable("/definitely/missing/codex")).resolves.toBe(false);
    const report = await runRealLlmSemanticQuality({ provider: "codex-cli", suite: "smoke", codexBin: "/definitely/missing/codex", env: { PATH: "/bin" } });
    expect(report.summary.total_cases).toBe(4);
    expect(report.summary.passed_cases).toBe(4);
    expect(report.environment.codex_cli_available).toBe(false);
    expect(report.cases.every((item) => {
      const providerResults = (item as { provider_results: Array<{ status: string; failure_code: string | null }> }).provider_results;
      return providerResults[0].status === "skipped" && providerResults[0].failure_code === "CODEX_CLI_UNAVAILABLE";
    })).toBe(true);
  });
});

