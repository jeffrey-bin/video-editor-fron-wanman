import { getStorageConfig } from "@/server/storage/config";
import { getStateRepository } from "@/server/state/repository";

export type StalledRepairResult = {
  repaired_job_ids: string[];
  requeued_job_ids?: string[];
  marked_stalled_job_ids?: string[];
  scanned_running_jobs?: number;
};

export const recordStalledRepairStarted = async (intervalSeconds: number) => {
  const now = new Date().toISOString();
  const config = getStorageConfig();
  await getStateRepository().mutate((database) => {
    const previous = database.schedulerHeartbeats.stalled_repair;
    const runningJobs = Object.values(database.jobs).filter((job) => job.status === "running").length;
    database.schedulerHeartbeats.stalled_repair = {
      name: "stalled_repair",
      runnerId: config.runnerId,
      status: "running",
      intervalSeconds,
      lastHeartbeatAt: now,
      lastRunStartedAt: now,
      lastRunFinishedAt: previous?.lastRunFinishedAt,
      lastRunDurationMs: previous?.lastRunDurationMs,
      lastScannedRunningJobs: runningJobs,
      lastRepairedJobs: previous?.lastRepairedJobs ?? [],
      lastRequeuedJobs: previous?.lastRequeuedJobs ?? [],
      lastMarkedStalledJobs: previous?.lastMarkedStalledJobs ?? [],
      updatedAt: now,
    };
  });
};

export const recordStalledRepairFinished = async (startedAtMs: number, result: StalledRepairResult) => {
  const now = new Date().toISOString();
  const config = getStorageConfig();
  await getStateRepository().mutate((database) => {
    const previous = database.schedulerHeartbeats.stalled_repair;
    database.schedulerHeartbeats.stalled_repair = {
      name: "stalled_repair",
      runnerId: config.runnerId,
      status: "healthy",
      intervalSeconds: previous?.intervalSeconds ?? config.jobLeaseSeconds,
      lastHeartbeatAt: now,
      lastRunStartedAt: previous?.lastRunStartedAt,
      lastRunFinishedAt: now,
      lastRunDurationMs: Date.now() - startedAtMs,
      lastScannedRunningJobs: result.scanned_running_jobs ?? previous?.lastScannedRunningJobs ?? 0,
      lastRepairedJobs: result.repaired_job_ids,
      lastRequeuedJobs: result.requeued_job_ids ?? [],
      lastMarkedStalledJobs: result.marked_stalled_job_ids ?? [],
      updatedAt: now,
    };
  });
};

export const recordStalledRepairFailed = async (intervalSeconds: number, error: unknown) => {
  const now = new Date().toISOString();
  const config = getStorageConfig();
  await getStateRepository().mutate((database) => {
    const previous = database.schedulerHeartbeats.stalled_repair;
    database.schedulerHeartbeats.stalled_repair = {
      name: "stalled_repair",
      runnerId: config.runnerId,
      status: "failed",
      intervalSeconds,
      lastHeartbeatAt: now,
      lastRunStartedAt: previous?.lastRunStartedAt,
      lastRunFinishedAt: now,
      lastRunDurationMs: previous?.lastRunStartedAt ? Date.now() - new Date(previous.lastRunStartedAt).getTime() : undefined,
      lastScannedRunningJobs: previous?.lastScannedRunningJobs ?? 0,
      lastRepairedJobs: previous?.lastRepairedJobs ?? [],
      lastRequeuedJobs: previous?.lastRequeuedJobs ?? [],
      lastMarkedStalledJobs: previous?.lastMarkedStalledJobs ?? [],
      lastErrorCode: "STALLED_REPAIR_FAILED",
      lastErrorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: now,
    };
  });
};
