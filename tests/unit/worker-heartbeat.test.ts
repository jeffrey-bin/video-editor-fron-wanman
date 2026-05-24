import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateRepository, resetStateRepositoryForTests } from "@/server/state/repository";

let dir = "";

describe("worker heartbeat", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-heartbeat-test-"));
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    vi.stubEnv("RUNNER_ID", "media-worker-test");
    vi.stubEnv("PROMPTCUT_RUNNER_ROLE", "media-worker");
    resetStateRepositoryForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetStateRepositoryForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("records worker heartbeat and refreshes job lease", async () => {
    await getStateRepository().mutate((database) => {
      database.jobs.export_1 = {
        id: "export_1",
        projectId: "project_demo",
        type: "timeline_export",
        status: "running",
        progress: 40,
        input: {},
        attempts: 1,
        maxAttempts: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    const { recordWorkerHeartbeat, refreshJobLease, listWorkerHeartbeats } = await import("@/server/workers/heartbeat");
    await recordWorkerHeartbeat({ currentJobId: "export_1", currentQueue: "timeline_export", processedJobsTotal: 3 });
    const lease = await refreshJobLease("export_1", "timeline_export");
    const database = await getStateRepository().load();
    expect(database.workerHeartbeats["media-worker-test"]).toMatchObject({ runnerId: "media-worker-test", role: "media-worker", currentJobId: "export_1" });
    expect(database.jobs.export_1.leaseOwner).toBe("media-worker-test");
    expect(database.jobs.export_1.leaseExpiresAt).toBe(lease);
    const workers = await listWorkerHeartbeats(90);
    expect(workers.workers[0].status).toBe("healthy");
  });

  it("marks stale workers and scheduler records in the health aggregate", async () => {
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    await getStateRepository().mutate((database) => {
      database.workerHeartbeats.stale_worker = {
        runnerId: "stale_worker",
        role: "media-worker",
        status: "healthy",
        version: "0.1.0",
        startedAt: staleAt,
        lastHeartbeatAt: staleAt,
        processedJobsTotal: 0,
        failedJobsTotal: 0,
        updatedAt: staleAt,
      };
      database.schedulerHeartbeats.stalled_repair = {
        name: "stalled_repair",
        runnerId: "cleanup-worker-test",
        status: "healthy",
        intervalSeconds: 60,
        lastHeartbeatAt: staleAt,
        lastScannedRunningJobs: 1,
        lastRepairedJobs: ["job_1"],
        lastRequeuedJobs: ["job_1"],
        lastMarkedStalledJobs: [],
        updatedAt: staleAt,
      };
    });
    const { listWorkerHeartbeats } = await import("@/server/workers/heartbeat");
    const aggregate = await listWorkerHeartbeats(30);
    expect(aggregate.workers[0].status).toBe("stale");
    expect(aggregate.scheduler).toMatchObject({ status: "stale", last_repair_result: { repaired_job_ids: ["job_1"], requeued_job_ids: ["job_1"] } });
  });
});
