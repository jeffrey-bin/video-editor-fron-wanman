import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { Writable } from "node:stream";
import { EditPlanResponseSchema, type EditPlanResponse, type LlmEditRequest } from "@/server/llm/edit-plan-protocol";

export type CodexCliOptions = {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  spawnImpl?: SpawnLike;
};

export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env: Record<string, string | undefined> },
) => {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: NodeJS.Signals) => boolean | void;
  on: (event: "error" | "close", listener: (value: Error | number | null) => void) => unknown;
};

export class CodexCliError extends Error {
  constructor(
    public code: "LLM_TIMEOUT" | "LLM_INVALID_JSON" | "LLM_SCHEMA_INVALID" | "LLM_PROCESS_FAILED",
    message: string,
    public rawOutput = "",
    public stderr = "",
  ) {
    super(message);
  }
}

const safeEnvKeys = ["PATH", "HOME", "LANG", "LC_ALL", "TERM"];

export const sanitizeEnv = (env: Record<string, string | undefined>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([key]) => safeEnvKeys.includes(key) || key.startsWith("CODEX_")));

export const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed) throw new CodexCliError("LLM_INVALID_JSON", "模型没有返回内容");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first < 0 || last <= first) throw new CodexCliError("LLM_INVALID_JSON", "模型返回格式无效", text.slice(0, 8192));
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      throw new CodexCliError("LLM_INVALID_JSON", "模型返回格式无效", text.slice(0, 8192));
    }
  }
};

const readStream = (stream: Readable): Promise<string> =>
  new Promise((resolve) => {
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });
    stream.on("end", () => resolve(output));
  });

export const buildCodexPrompt = (input: LlmEditRequest): string =>
  [
    "你是 PromptCut Studio 的本地 LLM 模拟器。",
    "只返回 JSON，不返回 Markdown、解释或代码块。",
    "禁止请求文件系统、shell、网络或修改源文件。",
    "根据下面 LlmEditRequest 生成 EditPlanResponse。",
    JSON.stringify(input, null, 2),
  ].join("\n\n");

export const generateCodexCliEditPlan = async (input: LlmEditRequest, options: CodexCliOptions = {}): Promise<EditPlanResponse> => {
  const bin = options.bin ?? process.env.CODEX_CLI_BIN ?? "codex";
  const model = options.model ?? process.env.CODEX_CLI_MODEL ?? "gpt-5.3-codex";
  const timeoutMs = options.timeoutMs ?? Number(process.env.CODEX_CLI_TIMEOUT_MS ?? 30000);
  const spawnFn = options.spawnImpl ?? (spawn as unknown as SpawnLike);
  const child = spawnFn(bin, ["exec", "--model", model, "--json"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: sanitizeEnv(process.env),
  });

  const stdoutPromise = readStream(child.stdout);
  const stderrPromise = readStream(child.stderr);
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(typeof code === "number" ? code : null));
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.stdin.end(buildCodexPrompt(input));

  const code = await exitPromise.finally(() => clearTimeout(timer));
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code === null) throw new CodexCliError("LLM_TIMEOUT", "Codex CLI 调用超时", stdout.slice(0, 8192), stderr);
  if (code !== 0) throw new CodexCliError("LLM_PROCESS_FAILED", `Codex CLI 退出码 ${code}`, stdout.slice(0, 8192), stderr);

  const json = extractJson(stdout);
  const parsed = EditPlanResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new CodexCliError("LLM_SCHEMA_INVALID", "模型输出未通过 EditPlanResponse schema 校验", stdout.slice(0, 8192), stderr);
  }
  return parsed.data;
};
