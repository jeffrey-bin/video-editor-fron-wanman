import { getStorageConfig } from "@/server/storage/config";

export type PromptCutQueueName = "asset_ingest" | "llm_edit_plan" | "timeline_export" | "cleanup";

export const enqueuePromptCutJob = async (queueName: PromptCutQueueName, jobId: string, runInline: () => Promise<void>) => {
  const config = getStorageConfig();
  if (config.stateDriver !== "external") {
    await runInline();
    return { mode: "local_inline" as const };
  }
  if (!config.redisUrl) throw new Error("REDIS_URL is required to enqueue external jobs");
  const { Queue } = await import("bullmq");
  const queue = new Queue(queueName, { connection: { url: config.redisUrl } });
  await queue.add(queueName, { jobId }, { jobId, attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000, removeOnFail: 5000 });
  await queue.close();
  return { mode: "bullmq" as const };
};
