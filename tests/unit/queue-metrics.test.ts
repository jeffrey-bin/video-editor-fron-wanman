import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateRepository, resetStateRepositoryForTests } from "@/server/state/repository";

let dir = "";

describe("queue metrics", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-queues-test-"));
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    resetStateRepositoryForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetStateRepositoryForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("aggregates DB-visible queue depth, runtime and Prometheus text", async () => {
    const now = Date.now();
    await getStateRepository().mutate((database) => {
      database.jobs.export_1 = {
        id: "export_1",
        projectId: "project_demo",
        type: "timeline_export",
        status: "queued",
        progress: 0,
        input: {},
        attempts: 0,
        maxAttempts: 2,
        createdAt: new Date(now - 120_000).toISOString(),
        updatedAt: new Date(now - 120_000).toISOString(),
      };
      database.jobs.export_2 = {
        id: "export_2",
        projectId: "project_demo",
        type: "timeline_export",
        status: "succeeded",
        progress: 100,
        input: {},
        attempts: 1,
        maxAttempts: 2,
        createdAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 10_000).toISOString(),
        startedAt: new Date(now - 40_000).toISOString(),
        finishedAt: new Date(now - 10_000).toISOString(),
      };
      database.workerHeartbeats.worker_1 = {
        runnerId: "worker_1",
        role: "media-worker",
        status: "healthy",
        version: "0.1.0",
        startedAt: new Date(now - 1000).toISOString(),
        lastHeartbeatAt: new Date(now).toISOString(),
        currentQueue: "timeline_export",
        currentJobId: "export_1",
        processedJobsTotal: 1,
        failedJobsTotal: 0,
        updatedAt: new Date(now).toISOString(),
      };
    });
    const { collectQueueMetrics, renderPrometheusMetrics } = await import("@/server/observability/metrics");
    const metrics = await collectQueueMetrics();
    const exportQueue = metrics.queues.find((queue) => queue.name === "timeline_export");
    expect(exportQueue).toMatchObject({ waiting: 1, completed_last_15m: 1, p95_runtime_seconds_last_1h: 30, consumer_count: 1 });
    expect(exportQueue?.oldest_waiting_age_seconds).toBeGreaterThanOrEqual(100);
    await expect(renderPrometheusMetrics()).resolves.toContain('promptcut_queue_waiting{queue="timeline_export"} 1');
  });
});
