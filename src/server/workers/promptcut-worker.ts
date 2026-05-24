import { Worker } from "bullmq";
import { getStorageConfig } from "@/server/storage/config";
import { processQueuedJob, repairStalledJobs } from "@/server/state/persistent";
import type { PromptCutQueueName } from "@/server/workers/queue";

const queueNames: PromptCutQueueName[] = ["asset_ingest", "llm_edit_plan", "timeline_export", "cleanup"];

export const createPromptCutWorkers = () => {
  const config = getStorageConfig();
  if (config.stateDriver !== "external") throw new Error("PromptCut BullMQ workers require PROMPTCUT_STATE_DRIVER=external");
  if (!config.redisUrl) throw new Error("REDIS_URL is required for PromptCut workers");
  return queueNames.map(
    (queueName) =>
      new Worker(
        queueName,
        async (job) => {
          await repairStalledJobs();
          await processQueuedJob(String(job.data.jobId));
        },
        { connection: { url: config.redisUrl }, lockDuration: config.jobLeaseSeconds * 1000 },
      ),
  );
};
