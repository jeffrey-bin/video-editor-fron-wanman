import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createObjectStore } from "@/server/storage/object-store";
import { getStorageConfig } from "@/server/storage/config";
import { getStateRepository } from "@/server/state/repository";
import { getRunnerInfo } from "@/server/workers/heartbeat";
import { containsUnredactedSecret, redactString } from "@/server/observability/redaction";

const execFileAsync = promisify(execFile);

export type HealthCheckStatus = "ok" | "failed" | "skipped";
export type HealthCheckResult = { status: HealthCheckStatus; latency_ms?: number; reason?: string; error_code?: string; version?: string };

const timed = async (fn: () => Promise<HealthCheckResult>): Promise<HealthCheckResult> => {
  const started = Date.now();
  try {
    const result = await Promise.race<HealthCheckResult>([
      fn(),
      new Promise((resolve) => setTimeout(() => resolve({ status: "failed", error_code: "TIMEOUT" }), 2000)),
    ]);
    return { ...result, latency_ms: Date.now() - started };
  } catch (error) {
    return { status: "failed", latency_ms: Date.now() - started, error_code: error instanceof Error ? error.message : "CHECK_FAILED" };
  }
};

export const checkDatabase = () => timed(async () => {
  await getStateRepository().load();
  return { status: "ok" };
});

export const checkRedis = () => timed(async () => {
  const config = getStorageConfig();
  if (!config.redisUrl) return { status: config.stateDriver === "external" ? "failed" : "skipped", reason: "redis_not_configured" };
  const Redis = (await import("ioredis")).default;
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 0, lazyConnect: true });
  try {
    await redis.connect();
    await redis.ping();
    return { status: "ok" };
  } finally {
    redis.disconnect();
  }
});

export const checkObjectStorage = () => timed(async () => {
  const store = createObjectStore();
  const key = `health/${getStorageConfig().runnerId}/${Date.now()}.txt`;
  await store.putObject(key, Buffer.from("ok"), { contentType: "text/plain" });
  await store.statObject(key);
  await store.deleteObject(key);
  return { status: "ok" };
});

export const checkBinaryVersion = (bin: string | undefined, name: "ffmpeg" | "ffprobe") => timed(async () => {
  if (!bin) return { status: "failed", error_code: `${name.toUpperCase()}_MISSING` };
  const result = await execFileAsync(bin, ["-version"], { timeout: 1500 });
  return { status: "ok", version: result.stdout.split("\n")[0]?.slice(0, 160) };
});

export const checkLlmProvider = () => timed(async () => {
  const provider = process.env.LLM_PROVIDER ?? "mock";
  if (provider === "mock") return { status: "ok", version: "mock" };
  if (provider !== "codex-cli") return { status: "failed", error_code: "LLM_PROVIDER_UNAVAILABLE" };
  const bin = process.env.CODEX_CLI_BIN ?? "codex";
  const result = await execFileAsync(bin, ["--version"], { timeout: 1500 });
  return { status: "ok", version: result.stdout.trim().slice(0, 160) };
});

export const collectReadyHealth = async () => {
  const role = process.env.PROMPTCUT_RUNNER_ROLE ?? "web";
  const checks = {
    database: await checkDatabase(),
    redis: await checkRedis(),
    object_storage: await checkObjectStorage(),
    ffmpeg: role === "media-worker" ? await checkBinaryVersion(process.env.FFMPEG_BIN ?? "ffmpeg", "ffmpeg") : { status: "skipped" as const, reason: "role_not_media_worker" },
    ffprobe: role === "media-worker" ? await checkBinaryVersion(process.env.FFPROBE_BIN ?? "ffprobe", "ffprobe") : { status: "skipped" as const, reason: "role_not_media_worker" },
    llm_provider: role === "llm-worker" ? await checkLlmProvider() : { status: "skipped" as const, reason: "role_not_llm_worker" },
  };
  const criticalFailed = checks.database.status === "failed" || checks.redis.status === "failed" || checks.ffmpeg.status === "failed" || checks.ffprobe.status === "failed" || checks.llm_provider.status === "failed";
  const degraded = !criticalFailed && checks.object_storage.status === "failed";
  return { status: criticalFailed ? "not_ready" : degraded ? "degraded" : "ready", role, runner_id: getStorageConfig().runnerId, checks };
};

export const collectDeepHealth = async () => {
  const ready = await collectReadyHealth();
  const fakeSecret = "OPENAI_API_KEY=sk-testsecret123456789 Authorization: Bearer tokentest123456789";
  const redacted = redactString(fakeSecret);
  return {
    ...ready,
    live: getRunnerInfo(),
    secret_redaction: {
      status: containsUnredactedSecret(redacted, ["sk-testsecret123456789", "tokentest123456789"]) ? "failed" : "ok",
      sample: redacted,
    },
  };
};
