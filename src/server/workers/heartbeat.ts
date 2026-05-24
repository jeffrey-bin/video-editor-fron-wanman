import { hostname } from "node:os";
import { getStorageConfig } from "@/server/storage/config";
import { getStateRepository, type JobRecord, type WorkerHeartbeatRecord } from "@/server/state/repository";

const version = process.env.npm_package_version ?? "0.1.0";
const commitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_SHA;

export const getRunnerInfo = () => {
  const config = getStorageConfig();
  return {
    service: "promptcut-studio",
    role: process.env.PROMPTCUT_RUNNER_ROLE ?? "web",
    runner_id: config.runnerId,
    version,
    commit_sha: commitSha,
    started_at: process.env.PROMPTCUT_STARTED_AT ?? new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  };
};

export const recordWorkerHeartbeat = async (
  input: Partial<Pick<WorkerHeartbeatRecord, "status" | "currentJobId" | "currentQueue" | "lastJobStartedAt" | "lastJobFinishedAt" | "processedJobsTotal" | "failedJobsTotal" | "metadata">> = {},
) => {
  const now = new Date().toISOString();
  const info = getRunnerInfo();
  const record: WorkerHeartbeatRecord = {
    runnerId: info.runner_id,
    role: info.role,
    status: input.status ?? "healthy",
    version: info.version,
    commitSha: info.commit_sha,
    hostname: hostname(),
    pid: process.pid,
    startedAt: info.started_at,
    lastHeartbeatAt: now,
    lastJobStartedAt: input.lastJobStartedAt,
    lastJobFinishedAt: input.lastJobFinishedAt,
    currentJobId: input.currentJobId,
    currentQueue: input.currentQueue,
    processedJobsTotal: input.processedJobsTotal ?? 0,
    failedJobsTotal: input.failedJobsTotal ?? 0,
    metadata: input.metadata,
    updatedAt: now,
  };
  await getStateRepository().mutate((database) => {
    const previous = database.workerHeartbeats[record.runnerId];
    const hasCurrentJob = Object.prototype.hasOwnProperty.call(input, "currentJobId");
    const hasCurrentQueue = Object.prototype.hasOwnProperty.call(input, "currentQueue");
    database.workerHeartbeats[record.runnerId] = {
      ...record,
      currentJobId: hasCurrentJob ? input.currentJobId : previous?.currentJobId,
      currentQueue: hasCurrentQueue ? input.currentQueue : previous?.currentQueue,
      processedJobsTotal: input.processedJobsTotal ?? previous?.processedJobsTotal ?? 0,
      failedJobsTotal: input.failedJobsTotal ?? previous?.failedJobsTotal ?? 0,
      lastJobStartedAt: input.lastJobStartedAt ?? previous?.lastJobStartedAt,
      lastJobFinishedAt: input.lastJobFinishedAt ?? previous?.lastJobFinishedAt,
    };
  });
  return record;
};

export const refreshJobLease = async (jobId: string, queue: JobRecord["type"]) => {
  const config = getStorageConfig();
  const leaseExpiresAt = new Date(Date.now() + config.jobLeaseSeconds * 1000).toISOString();
  await getStateRepository().mutate((database) => {
    const job = database.jobs[jobId];
    if (!job) return;
    job.leaseOwner = config.runnerId;
    job.leaseExpiresAt = leaseExpiresAt;
    job.updatedAt = new Date().toISOString();
    const heartbeat = database.workerHeartbeats[config.runnerId];
    if (heartbeat) {
      heartbeat.currentJobId = jobId;
      heartbeat.currentQueue = queue;
      heartbeat.lastHeartbeatAt = new Date().toISOString();
      heartbeat.updatedAt = heartbeat.lastHeartbeatAt;
    }
  });
  return leaseExpiresAt;
};

let activeWorkerJob: { jobId: string; queue: JobRecord["type"] } | undefined;

export const setActiveWorkerJob = (jobId: string, queue: JobRecord["type"]) => {
  activeWorkerJob = { jobId, queue };
};

export const clearActiveWorkerJob = (jobId?: string) => {
  if (!jobId || activeWorkerJob?.jobId === jobId) activeWorkerJob = undefined;
};

export const startWorkerHeartbeatLoop = (intervalMs?: number) => {
  const config = getStorageConfig();
  const timer = setInterval(() => {
    const active = activeWorkerJob;
    const heartbeat = active ? recordWorkerHeartbeat({ currentJobId: active.jobId, currentQueue: active.queue }).then(() => refreshJobLease(active.jobId, active.queue)) : recordWorkerHeartbeat();
    heartbeat.catch(() => undefined);
  }, intervalMs ?? Math.max(5000, Math.floor((config.jobLeaseSeconds * 1000) / 3)));
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};

export const listWorkerHeartbeats = async (staleAfterSeconds?: number) => {
  const config = getStorageConfig();
  const staleAfter = staleAfterSeconds ?? Math.max(90, config.jobLeaseSeconds * 2);
  const cutoff = Date.now() - staleAfter * 1000;
  const database = await getStateRepository().load();
  return {
    generated_at: new Date().toISOString(),
    stale_after_seconds: staleAfter,
    workers: Object.values(database.workerHeartbeats).map((worker) => ({
      ...worker,
      status: new Date(worker.lastHeartbeatAt).getTime() < cutoff ? "stale" : worker.status,
    })),
    scheduler: database.schedulerHeartbeats.stalled_repair
      ? {
          ...database.schedulerHeartbeats.stalled_repair,
          status: new Date(database.schedulerHeartbeats.stalled_repair.lastHeartbeatAt).getTime() < cutoff ? "stale" : database.schedulerHeartbeats.stalled_repair.status,
          last_repair_result: {
            scanned_running_jobs: database.schedulerHeartbeats.stalled_repair.lastScannedRunningJobs,
            repaired_job_ids: database.schedulerHeartbeats.stalled_repair.lastRepairedJobs,
            requeued_job_ids: database.schedulerHeartbeats.stalled_repair.lastRequeuedJobs,
            marked_stalled_job_ids: database.schedulerHeartbeats.stalled_repair.lastMarkedStalledJobs,
          },
        }
      : null,
  };
};
