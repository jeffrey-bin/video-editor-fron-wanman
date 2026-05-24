import { randomUUID } from "node:crypto";
import { redactAndTruncate, redactValue } from "@/server/observability/redaction";
import { getStorageConfig } from "@/server/storage/config";
import { getStateRepository, type JobDiagnosticEventRecord } from "@/server/state/repository";

export const standardErrorRetryable = (code: string) =>
  new Set(["OBJECT_NOT_FOUND", "FFPROBE_FAILED", "FFMPEG_FAILED", "FFMPEG_TIMEOUT", "LLM_PROVIDER_UNAVAILABLE", "CODEX_CLI_FAILED", "CODEX_CLI_TIMEOUT", "QUEUE_DISPATCH_FAILED"]).has(code);

export const classifyJobError = (phase: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/FFMPEG_TIMEOUT/.test(message)) return { code: "FFMPEG_TIMEOUT", phase, retryable: true };
  if (/ffmpeg|EXPORT_FAILED/i.test(message)) return { code: "FFMPEG_FAILED", phase, retryable: true };
  if (/CODEX_CLI_TIMEOUT/.test(message)) return { code: "CODEX_CLI_TIMEOUT", phase, retryable: true };
  if (/CODEX_CLI_FAILED/.test(message)) return { code: "CODEX_CLI_FAILED", phase, retryable: true };
  if (/LLM_SCHEMA_INVALID/.test(message)) return { code: "LLM_SCHEMA_INVALID", phase, retryable: false };
  if (/LLM|provider/i.test(message)) return { code: "LLM_PROVIDER_UNAVAILABLE", phase, retryable: true };
  if (/TIMELINE_VERSION_CONFLICT/.test(message)) return { code: "TIMELINE_VERSION_CONFLICT", phase, retryable: false };
  if (/OBJECT_CHECKSUM_MISMATCH/.test(message)) return { code: "OBJECT_CHECKSUM_MISMATCH", phase, retryable: false };
  if (/OBJECT|ASSET|EXPORT_NOT_FOUND/.test(message)) return { code: "OBJECT_NOT_FOUND", phase, retryable: true };
  return { code: "UNKNOWN_INTERNAL_ERROR", phase, retryable: false };
};

export type DiagnosticInput = Omit<JobDiagnosticEventRecord, "id" | "createdAt" | "runnerId" | "stderrPreview" | "stdoutPreview" | "command"> & {
  id?: string;
  runnerId?: string;
  stderrPreview?: unknown;
  stdoutPreview?: unknown;
  command?: unknown;
};

export const writeJobDiagnosticEvent = async (input: DiagnosticInput) => {
  const config = getStorageConfig();
  const event: JobDiagnosticEventRecord = {
    id: input.id ?? `diag_${randomUUID().slice(0, 12)}`,
    jobId: input.jobId,
    projectId: input.projectId,
    type: input.type,
    phase: input.phase,
    code: input.code,
    message: redactAndTruncate(input.message, 512),
    retryable: input.retryable,
    runnerId: input.runnerId ?? config.runnerId,
    queue: input.queue,
    attempt: input.attempt,
    command: redactValue(input.command),
    stderrPreview: input.stderrPreview === undefined ? undefined : redactAndTruncate(input.stderrPreview),
    stdoutPreview: input.stdoutPreview === undefined ? undefined : redactAndTruncate(input.stdoutPreview),
    objectKey: input.objectKey?.replace(/\/original\/[^/]+$/, "/original/[REDACTED]"),
    timelineVersion: input.timelineVersion,
    traceId: input.traceId,
    createdAt: new Date().toISOString(),
  };
  await getStateRepository().mutate((database) => {
    database.diagnostics[event.jobId] = [...(database.diagnostics[event.jobId] ?? []), event];
  });
  return event;
};

export const listJobDiagnostics = async (jobId: string) => {
  const database = await getStateRepository().load();
  return database.diagnostics[jobId] ?? [];
};
