import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Writable } from "node:stream";
import { EditPlanResponseSchema, type EditPlanResponse, type LlmEditRequest } from "@/server/llm/edit-plan-protocol";
import { assertNoRealLlmSecrets } from "@/server/llm/real-llm-provider-isolation";

export type CodexCliOptions = {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  spawnImpl?: SpawnLike;
};

export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env: Record<string, string | undefined>; cwd: string },
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

const safeEnvKeys = ["PATH", "LANG", "LC_ALL", "TERM"];

export const sanitizeEnv = (env: Record<string, string | undefined>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && safeEnvKeys.includes(key)));

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
    "返回对象必须严格包含这些顶层字段：request_id、status、summary、confidence、requires_confirmation、warnings、operations、unsupported_intents；failed 时还必须包含 error。",
    "warnings 数组元素必须是 {\"code\":\"...\",\"message\":\"...\"}；unsupported_intents 数组元素必须是 {\"intent\":\"...\",\"reason\":\"...\"}，不能使用 message 字段替代 reason。",
    "operation 必须包含 id、type、target、params、rationale；不能省略 params，即使为空也返回 {}。",
    "示例 failed：{\"request_id\":\"输入 request_id\",\"status\":\"failed\",\"summary\":\"源文件保护禁止覆盖原视频。\",\"confidence\":0.95,\"requires_confirmation\":true,\"warnings\":[],\"operations\":[],\"unsupported_intents\":[],\"error\":{\"code\":\"SOURCE_FILE_PROTECTION\",\"message\":\"不允许修改或覆盖源文件，只能导出新副本。\"}}",
    "示例 partial：{\"request_id\":\"输入 request_id\",\"status\":\"partial\",\"summary\":\"能力边界需要用户确认。\",\"confidence\":0.55,\"requires_confirmation\":true,\"warnings\":[{\"code\":\"UNSUPPORTED_GENERATION\",\"message\":\"对象移除当前不支持。\"}],\"operations\":[],\"unsupported_intents\":[{\"intent\":\"对象移除\",\"reason\":\"当前版本不支持生成式对象移除。\"}]}",
    "禁止请求文件系统、shell、网络或修改源文件。",
    "你只能输出 EditPlanResponse JSON。LLM 只生成结构化 edit plan，绝不执行 FFmpeg、shell、读写路径或覆盖源文件。",
    "真实 LLM 语义门禁规则：要求覆盖/修改源文件必须 failed + error.code SOURCE_FILE_PROTECTION + operations=[]；对象移除/换脸/补帧必须 partial 或 failed，unsupported_intents 说明能力边界，禁止用 adjust_video 冒充；冲突指令必须 failed 或 partial 且不生成破坏性操作；删除、静音、批量字幕改写、导出 preset 必须 requires_confirmation=true。",
    "中文 case 规则：'从我说大家好那里开始' 可依据 transcript_segments 删除 0 到大家好 start_ms；'人声太小，背景音乐别变' 只允许作用 voice track/clip，不能调整 music 或视频；'把路人抹掉' 是不支持的对象移除；'直接覆盖原视频' 必须 failed。",
    "P4 音频 operation 只能从 available_operations 中选择：reduce_noise、equalize_loudness、duck_music、mute_range、apply_audio_fade、add_subtitle、update_subtitle、shift_audio、shift_subtitle_timing、mark_review_range。",
    "参数范围：reduce_noise.strength 0..1 且默认 <=0.55，>0.7 必须 warning 并 requires_confirmation=true；equalize_loudness target_lufs -24..-12、max_gain_db 0..12、limit_peak_dbfs <= -1；duck_db -24..0；shift_audio offset_ms 绝对值 <=3000，>1000 高风险确认。",
    "analysis_source=none 时不得声称完成真实音频分析；只能基于用户明确时间/偏移生成保守操作，或返回 partial + AUDIO_ANALYSIS_REQUIRED。",
    "role=unknown|mixed 时，duck_music、单独人声降噪、背景音乐静音必须 partial + TRACK_ROLE_UNKNOWN 或 requires_confirmation=true。",
    "转写/字幕只能使用 context.audio.analysis.transcript_segments；mock/fixture transcript 必须 warning 标注来源，confidence <0.85 必须 requires_confirmation=true；没有 transcript 不得编造字幕文本。",
    "failed 必须 operations=[] 且包含 error；partial 必须包含 warnings 或 unsupported_intents；所有 operation 必须属于输入 available_operations。",
    "错误码可用：NO_AUDIO_TRACK、TRACK_LOCKED、TRACK_ROLE_UNKNOWN、AUDIO_ANALYSIS_REQUIRED、TRANSCRIPTION_UNAVAILABLE、UNSUPPORTED_PERFECT_RESTORATION、UNSUPPORTED_VOICE_IDENTITY_CHANGE、SYNC_SHIFT_OUT_OF_BOUNDS、LLM_INVALID_JSON。",
    "根据下面 LlmEditRequest 生成 EditPlanResponse。",
    JSON.stringify(input, null, 2),
  ].join("\n\n");

const getTimeoutMs = (value: number | string | undefined) => {
  const parsed = Number(value ?? 30000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
};

export const generateCodexCliEditPlan = async (input: LlmEditRequest, options: CodexCliOptions = {}): Promise<EditPlanResponse> => {
  assertNoRealLlmSecrets(options.env ?? process.env);
  const bin = options.bin ?? process.env.CODEX_CLI_BIN ?? "codex";
  const model = options.model ?? process.env.CODEX_CLI_MODEL ?? "gpt-5.3-codex";
  const timeoutMs = getTimeoutMs(options.timeoutMs ?? process.env.CODEX_CLI_TIMEOUT_MS);
  const spawnFn = options.spawnImpl ?? (spawn as unknown as SpawnLike);
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "promptcut-codex-")));
  const outputLastMessage = "promptcut-codex-output.txt";
  const child = spawnFn(bin, ["exec", "--model", model, "--sandbox", "read-only", "--config", "approval_policy=\"never\"", "--config", "sandbox_network_access=false", "--skip-git-repo-check", "--json", "--output-last-message", outputLastMessage], {
    stdio: ["pipe", "pipe", "pipe"],
    env: sanitizeEnv(options.env ?? process.env),
    cwd,
  });

  const stdoutPromise = readStream(child.stdout);
  const stderrPromise = readStream(child.stderr);
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(typeof code === "number" ? code : null));
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 100).unref();
  }, timeoutMs);
  child.stdin.end(buildCodexPrompt(input));

  const code = await exitPromise.finally(() => clearTimeout(timer));
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (timedOut || code === null) throw new CodexCliError("LLM_TIMEOUT", "Codex CLI 调用超时", stdout.slice(0, 8192), stderr);
  if (code !== 0) throw new CodexCliError("LLM_PROCESS_FAILED", `Codex CLI 退出码 ${code}`, stdout.slice(0, 8192), stderr);

  let modelOutput = stdout;
  try {
    modelOutput = await readFile(join(cwd, outputLastMessage), "utf8");
  } catch {
    modelOutput = stdout;
  }
  const json = extractJson(modelOutput);
  const parsed = EditPlanResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new CodexCliError("LLM_SCHEMA_INVALID", "模型输出未通过 EditPlanResponse schema 校验", modelOutput.slice(0, 8192), stderr);
  }
  return parsed.data;
};
