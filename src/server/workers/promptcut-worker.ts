import { Worker } from "bullmq";
import { getStorageConfig } from "@/server/storage/config";
import { getJob, processQueuedJob, repairStalledJobs } from "@/server/state/persistent";
import { enqueuePromptCutJob } from "@/server/workers/queue";
import type { PromptCutQueueName } from "@/server/workers/queue";

const queueNames: PromptCutQueueName[] = ["asset_ingest", "llm_edit_plan", "timeline_export", "cleanup"];
const requeueableJobTypes = new Set<PromptCutQueueName>(["llm_edit_plan", "timeline_export"]);

export const repairAndRequeueStalledJobs = async () => {
  const repaired = await repairStalledJobs();
  const requeued: string[] = [];
  for (const jobId of repaired.repaired_job_ids) {
    const job = await getJob(jobId);
    if (!job || job.status !== "queued" || !requeueableJobTypes.has(job.type)) continue;
    await enqueuePromptCutJob(job.type, job.id, () => processQueuedJob(job.id));
    requeued.push(job.id);
  }
  return { ...repaired, requeued_job_ids: requeued };
};

export const startStalledJobRepairLoop = (intervalMs?: number) => {
  const config = getStorageConfig();
  if (config.stateDriver !== "external") throw new Error("PromptCut stalled job repair loop requires PROMPTCUT_STATE_DRIVER=external");
  const timer = setInterval(() => {
    repairAndRequeueStalledJobs().catch((error) => {
      console.error("PromptCut stalled job repair failed", error);
    });
  }, intervalMs ?? Math.max(5000, config.jobLeaseSeconds * 1000));
  return { stop: () => clearInterval(timer) };
};

export const createPromptCutWorkers = () => {
  const config = getStorageConfig();
  if (config.stateDriver !== "external") throw new Error("PromptCut BullMQ workers require PROMPTCUT_STATE_DRIVER=external");
  if (!config.redisUrl) throw new Error("REDIS_URL is required for PromptCut workers");
  return queueNames.map(
    (queueName) =>
      new Worker(
        queueName,
        async (job) => {
          await repairAndRequeueStalledJobs();
          await processQueuedJob(String(job.data.jobId));
        },
        { connection: { url: config.redisUrl }, lockDuration: config.jobLeaseSeconds * 1000 },
      ),
  );
};
