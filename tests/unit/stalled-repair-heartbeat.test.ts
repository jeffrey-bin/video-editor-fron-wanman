import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateRepository, resetStateRepositoryForTests } from "@/server/state/repository";

let dir = "";

describe("stalled repair heartbeat", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-scheduler-test-"));
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    vi.stubEnv("RUNNER_ID", "cleanup-worker-test");
    resetStateRepositoryForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetStateRepositoryForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("records started, finished and failed stalled repair state", async () => {
    const scheduler = await import("@/server/workers/scheduler-heartbeat");
    await scheduler.recordStalledRepairStarted(60);
    await scheduler.recordStalledRepairFinished(Date.now() - 25, { repaired_job_ids: ["job_1"], requeued_job_ids: ["job_1"], marked_stalled_job_ids: [] });
    let record = (await getStateRepository().load()).schedulerHeartbeats.stalled_repair;
    expect(record).toMatchObject({ runnerId: "cleanup-worker-test", status: "healthy", lastRepairedJobs: ["job_1"], lastRequeuedJobs: ["job_1"] });
    await scheduler.recordStalledRepairFailed(60, new Error("redis down"));
    record = (await getStateRepository().load()).schedulerHeartbeats.stalled_repair;
    expect(record).toMatchObject({ status: "failed", lastErrorCode: "STALLED_REPAIR_FAILED", lastErrorMessage: "redis down" });
  });
});
