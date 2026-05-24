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
});
