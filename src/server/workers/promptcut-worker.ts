import { Worker } from "bullmq";
import { writeStructuredLog } from "@/server/observability/logger";
import { getStorageConfig } from "@/server/storage/config";
import { getJob, processQueuedJob, repairStalledJobs } from "@/server/state/persistent";
import { clearActiveWorkerJob, recordWorkerHeartbeat, refreshJobLease, setActiveWorkerJob, startWorkerHeartbeatLoop } from "@/server/workers/heartbeat";
import { recordStalledRepairFailed, recordStalledRepairFinished, recordStalledRepairSkipped, recordStalledRepairStarted, withStalledRepairLock } from "@/server/workers/scheduler-heartbeat";
import { enqueuePromptCutJob } from "@/server/workers/queue";
import type { PromptCutQueueName } from "@/server/workers/queue";

const queueNames: PromptCutQueueName[] = ["asset_ingest", "llm_edit_plan", "timeline_export", "cleanup"];
const requeueableJobTypes = new Set<PromptCutQueueName>(["llm_edit_plan", "timeline_export"]);

export const repairAndRequeueStalledJobs = async () => {
  const config = getStorageConfig();
  return withStalledRepairLock(config.jobLeaseSeconds, async (lock) => {
    if (!lock.acquired) {
      await recordStalledRepairSkipped(config.jobLeaseSeconds, lock.owner);
      writeStructuredLog("info", "stalled_repair_lock_skipped", { lock_key: "promptcut:stalled-repair", owner: lock.owner });
      return { repaired_job_ids: [], requeued_job_ids: [], scanned_running_jobs: 0, lock_acquired: false, lock_owner: lock.owner };
    }
    const startedAt = Date.now();
    await recordStalledRepairStarted(config.jobLeaseSeconds);
    const repaired = await repairStalledJobs();
    const requeued: string[] = [];
    for (const jobId of repaired.repaired_job_ids) {
      const job = await getJob(jobId);
      if (!job || job.status !== "queued" || !requeueableJobTypes.has(job.type)) continue;
      await enqueuePromptCutJob(job.type, job.id, () => processQueuedJob(job.id));
      requeued.push(job.id);
    }
    const result = { ...repaired, requeued_job_ids: requeued, scanned_running_jobs: repaired.repaired_job_ids.length, lock_acquired: true };
    await recordStalledRepairFinished(startedAt, result);
    writeStructuredLog("info", "stalled_repair_finished", { repaired_job_ids: repaired.repaired_job_ids, requeued_job_ids: requeued });
    return result;
  });
};

export const startStalledJobRepairLoop = (intervalMs?: number) => {
  const config = getStorageConfig();
  if (config.stateDriver !== "external") throw new Error("PromptCut stalled job repair loop requires PROMPTCUT_STATE_DRIVER=external");
  const timer = setInterval(() => {
    repairAndRequeueStalledJobs().catch((error) => {
      recordStalledRepairFailed(Math.round((intervalMs ?? config.jobLeaseSeconds * 1000) / 1000), error).catch(() => undefined);
      writeStructuredLog("error", "stalled_repair_failed", { error });
    });
  }, intervalMs ?? Math.max(5000, config.jobLeaseSeconds * 1000));
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};

export const createPromptCutWorkers = () => {
  const config = getStorageConfig();
  if (config.stateDriver !== "external") throw new Error("PromptCut BullMQ workers require PROMPTCUT_STATE_DRIVER=external");
  if (!config.redisUrl) throw new Error("REDIS_URL is required for PromptCut workers");
  startWorkerHeartbeatLoop();
  return queueNames.map(
    (queueName) =>
      new Worker(
        queueName,
        async (job) => {
          await recordWorkerHeartbeat({ currentJobId: String(job.data.jobId), currentQueue: queueName, lastJobStartedAt: new Date().toISOString() });
          setActiveWorkerJob(String(job.data.jobId), queueName);
          await refreshJobLease(String(job.data.jobId), queueName);
          await repairAndRequeueStalledJobs();
          try {
            await processQueuedJob(String(job.data.jobId));
            clearActiveWorkerJob(String(job.data.jobId));
            await recordWorkerHeartbeat({ currentJobId: undefined, currentQueue: undefined, lastJobFinishedAt: new Date().toISOString() });
            writeStructuredLog("info", "job_succeeded", { job_id: String(job.data.jobId), queue: queueName });
          } catch (error) {
            clearActiveWorkerJob(String(job.data.jobId));
            await recordWorkerHeartbeat({ status: "healthy", currentJobId: undefined, currentQueue: undefined, lastJobFinishedAt: new Date().toISOString() });
            writeStructuredLog("error", "job_failed", { job_id: String(job.data.jobId), queue: queueName, error });
            throw error;
          }
        },
        { connection: { url: config.redisUrl }, lockDuration: config.jobLeaseSeconds * 1000 },
      ),
  );
};
