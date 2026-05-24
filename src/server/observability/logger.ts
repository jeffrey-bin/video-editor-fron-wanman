import { getStorageConfig } from "@/server/storage/config";
import { redactValue } from "@/server/observability/redaction";

export type LogLevel = "info" | "warn" | "error";

export const writeStructuredLog = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
  const config = getStorageConfig();
  const line = {
    ts: new Date().toISOString(),
    level,
    service: "promptcut-studio",
    role: process.env.PROMPTCUT_RUNNER_ROLE ?? "web",
    runner_id: config.runnerId,
    event,
    ...fields,
  };
  const serialized = JSON.stringify(redactValue(line));
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
};
