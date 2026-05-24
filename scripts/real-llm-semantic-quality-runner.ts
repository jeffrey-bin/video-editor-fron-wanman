import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runRealLlmSemanticQuality, type RealLlmSemanticSuite } from "@/server/llm/real-llm-semantic-eval";
import { RealLlmSemanticProviderSchema } from "@/server/llm/real-llm-provider-isolation";

type CliOptions = {
  provider: "mock" | "codex-cli" | "both";
  suite: RealLlmSemanticSuite;
  compareProviders: boolean;
  report: string;
};

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = { provider: "mock", suite: "full", compareProviders: false, report: "test-results/real-llm-semantic-quality-report.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const value = arg.includes("=") ? arg.split("=").slice(1).join("=") : next;
    if (arg === "--compare-providers") {
      options.compareProviders = true;
      continue;
    }
    if (arg.startsWith("--provider")) {
      if (value !== "both" && !RealLlmSemanticProviderSchema.safeParse(value).success) throw new Error(`Invalid --provider ${value}`);
      options.provider = value as CliOptions["provider"];
      if (!arg.includes("=")) index += 1;
    } else if (arg.startsWith("--suite")) {
      if (value !== "smoke" && value !== "full") throw new Error(`Invalid --suite ${value}`);
      options.suite = value;
      if (!arg.includes("=")) index += 1;
    } else if (arg.startsWith("--report")) {
      if (!value) throw new Error("--report requires a path");
      options.report = value;
      if (!arg.includes("=")) index += 1;
    }
  }
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const report = await runRealLlmSemanticQuality({
    provider: options.provider,
    suite: options.suite,
    compareProviders: options.compareProviders,
    codexBin: process.env.CODEX_CLI_BIN,
    env: process.env,
  });
  const reportPath = resolve(process.cwd(), options.report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.summary.failed_cases > 0 || report.summary.hard_failures > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

