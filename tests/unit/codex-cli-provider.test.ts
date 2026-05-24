import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildCodexPrompt, extractJson, generateCodexCliEditPlan, sanitizeEnv } from "@/server/llm/codex-cli-provider";
import type { LlmEditRequest } from "@/server/llm/edit-plan-protocol";

const request: LlmEditRequest = {
  request_id: "550e8400-e29b-41d4-a716-446655440000",
  project: { project_id: "project", duration_ms: 10000, timeline_version: 1 },
  user_intent: { prompt: "剪掉开头", locale: "zh-CN", scope: { type: "timeline", start_ms: 0, end_ms: 10000 } },
  context: { assets: [], clips: [], subtitles: [], available_operations: ["delete_range"] },
  constraints: { max_operations: 50, require_user_confirmation: true, do_not_modify_source_files: true },
};

const validPlan = JSON.stringify({
  request_id: request.request_id,
  status: "succeeded",
  summary: "ok",
  confidence: 0.8,
  requires_confirmation: true,
  warnings: [],
  operations: [],
  unsupported_intents: [],
});

type SpawnCall = { command: string; args: string[]; options: { cwd: string; env: Record<string, string | undefined> } };

const mockSpawn = (stdoutText: string, code: number | null, stderrText = "", calls: SpawnCall[] = []) => {
  return ((command: string, args: string[], options: SpawnCall["options"]) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", null);
      child.stdout.end();
      child.stderr.end();
    };
    queueMicrotask(() => {
      child.stdout.end(stdoutText);
      child.stderr.end(stderrText);
      child.emit("close", code);
    });
    return child;
  }) as never;
};

const hangingSpawn = (calls: SpawnCall[] = [], onKill: () => void = () => undefined) => {
  return ((command: string, args: string[], options: SpawnCall["options"]) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      onKill();
      child.stdout.end("");
      child.stderr.end("secret stderr");
      child.emit("close", null);
    };
    return child;
  }) as never;
};

describe("codex cli provider", () => {
  it("builds a P4 audio constrained JSON-only prompt", () => {
    const prompt = buildCodexPrompt(request);
    expect(prompt).toContain("P4 音频 operation");
    expect(prompt).toContain("analysis_source=none");
    expect(prompt).toContain("不得声称完成真实音频分析");
    expect(prompt).toContain("failed 必须 operations=[]");
    expect(prompt).toContain("不得编造字幕文本");
  });

  it("extracts JSON from plain and markdown-wrapped stdout", () => {
    expect(extractJson(validPlan)).toEqual(JSON.parse(validPlan));
    expect(extractJson(`text\n\`\`\`json\n${validPlan}\n\`\`\``)).toEqual(JSON.parse(validPlan));
    expect(() => extractJson("not json")).toThrow("模型返回格式无效");
  });

  it("parses successful CLI output through schema", async () => {
    const calls: SpawnCall[] = [];
    const plan = await generateCodexCliEditPlan(request, { spawnImpl: mockSpawn(validPlan, 0, "", calls), timeoutMs: 100, cwd: "/tmp/promptcut-codex-test", env: { PATH: "/bin", HOME: "/home/me", CODEX_HOME: "/secret", LANG: "C" } });
    expect(plan.summary).toBe("ok");
    expect(calls[0].args).toEqual(["exec", "--model", "gpt-5.3-codex", "--sandbox", "read-only", "--ask-for-approval", "never", "--config", "sandbox_network_access=false", "--json"]);
    expect(calls[0].options.cwd).toBe("/tmp/promptcut-codex-test");
    expect(calls[0].options.env).toEqual({ PATH: "/bin", LANG: "C" });
  });

  it("reports invalid JSON, schema invalid, non-zero exit and sanitized env", async () => {
    await expect(generateCodexCliEditPlan(request, { spawnImpl: mockSpawn("bad", 0), timeoutMs: 100 })).rejects.toMatchObject({ code: "LLM_INVALID_JSON" });
    await expect(generateCodexCliEditPlan(request, { spawnImpl: mockSpawn(JSON.stringify({ status: "succeeded" }), 0), timeoutMs: 100 })).rejects.toMatchObject({ code: "LLM_SCHEMA_INVALID" });
    await expect(generateCodexCliEditPlan(request, { spawnImpl: mockSpawn("", 2, "boom"), timeoutMs: 100 })).rejects.toMatchObject({ code: "LLM_PROCESS_FAILED", stderr: "boom" });
    expect(sanitizeEnv({ PATH: "/bin", SECRET: "no", HOME: "/home/me", CODEX_HOME: "/tmp" })).toEqual({ PATH: "/bin" });
  });

  it("kills timed out Codex CLI processes and returns a sanitized user-facing error", async () => {
    const killed = vi.fn();
    await expect(generateCodexCliEditPlan(request, { spawnImpl: hangingSpawn([], killed), timeoutMs: 1 })).rejects.toMatchObject({
      code: "LLM_TIMEOUT",
      message: "Codex CLI 调用超时",
    });
    expect(killed).toHaveBeenCalled();
  });
});
