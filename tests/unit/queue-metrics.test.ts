import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateRepository, resetStateRepositoryForTests } from "@/server/state/repository";

const getJobCountsMock = vi.fn(async () => ({ waiting: 2, delayed: 1, active: 1 }));
const getWorkersMock = vi.fn(async () => [{ id: "worker-1" }, { id: "worker-2" }]);
const closeMock = vi.fn(async () => undefined);

vi.mock("bullmq", () => ({
  Queue: vi.fn(() => ({ getJobCounts: getJobCountsMock, getWorkers: getWorkersMock, close: closeMock })),
}));

let dir = "";

describe("queue metrics", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-queues-test-"));
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    getJobCountsMock.mockClear();
    getWorkersMock.mockClear();
    closeMock.mockClear();
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
      database.jobs.llm_1 = {
        id: "llm_1",
        projectId: "project_demo",
        type: "llm_edit_plan",
        status: "succeeded",
        progress: 100,
        input: { request_id: "request_1" },
        attempts: 1,
        maxAttempts: 1,
        createdAt: new Date(now - 50_000).toISOString(),
        updatedAt: new Date(now - 20_000).toISOString(),
        startedAt: new Date(now - 35_000).toISOString(),
        finishedAt: new Date(now - 20_000).toISOString(),
      };
      database.pendingPlans.request_1 = {
        requestId: "request_1",
        projectId: "project_demo",
        timelineVersion: 1,
        plan: { request_id: "00000000-0000-4000-8000-000000000001", status: "succeeded", summary: "ok", confidence: 0.9, requires_confirmation: true, warnings: [], operations: [], unsupported_intents: [] },
        state: "ready",
        provider: "codex-cli",
        prompt: "cut intro",
        createdAt: new Date(now - 20_000).toISOString(),
        updatedAt: new Date(now - 20_000).toISOString(),
      };
      database.diagnostics.export_3 = [
        {
          id: "diag_1",
          jobId: "export_3",
          projectId: "project_demo",
          type: "error",
          phase: "render",
          code: "FFMPEG_FAILED",
          message: "ffmpeg exited with code 2",
          retryable: true,
          createdAt: new Date(now - 5000).toISOString(),
        },
      ];
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
      database.schedulerHeartbeats.stalled_repair = {
        name: "stalled_repair",
        runnerId: "cleanup-worker-1",
        status: "healthy",
        intervalSeconds: 60,
        lastHeartbeatAt: new Date(now).toISOString(),
        lastRunFinishedAt: new Date(now - 5000).toISOString(),
        lastScannedRunningJobs: 0,
        lastRepairedJobs: [],
        lastRequeuedJobs: [],
        lastMarkedStalledJobs: [],
        updatedAt: new Date(now).toISOString(),
      };
    });
    const { collectQueueMetrics, renderPrometheusMetrics } = await import("@/server/observability/metrics");
    const metrics = await collectQueueMetrics();
    const exportQueue = metrics.queues.find((queue) => queue.name === "timeline_export");
    expect(exportQueue).toMatchObject({ waiting: 1, completed_last_15m: 1, p95_runtime_seconds_last_1h: 30, consumer_count: 1 });
    expect(exportQueue?.oldest_waiting_age_seconds).toBeGreaterThanOrEqual(100);
    const rendered = await renderPrometheusMetrics();
    expect(rendered).toContain('promptcut_queue_waiting{queue="timeline_export"} 1');
    expect(rendered).toContain('promptcut_job_runtime_seconds_bucket{type="timeline_export",le="30"} 1');
    expect(rendered).toContain('promptcut_job_queue_wait_seconds_bucket{type="timeline_export",le="30"} 1');
    expect(rendered).toContain('promptcut_llm_provider_latency_seconds_bucket{provider="codex-cli",le="30"} 1');
    expect(rendered).toContain('promptcut_ffmpeg_exit_total{exit_code="2"} 1');
    expect(rendered).toContain('promptcut_stalled_repair_last_success_age_seconds{runner_id="cleanup-worker-1"}');
  });

  it("uses BullMQ counts for external queue metrics and closes queues", async () => {
    await getStateRepository().mutate((database) => {
      database.jobs.export_queued = {
        id: "export_queued",
        projectId: "project_demo",
        type: "timeline_export",
        status: "queued",
        progress: 0,
        input: {},
        attempts: 0,
        maxAttempts: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    const { collectQueueMetrics } = await import("@/server/observability/metrics");
    const metrics = await collectQueueMetrics();
    expect(metrics.queues.find((queue) => queue.name === "timeline_export")).toMatchObject({ waiting: 2, delayed: 1, active: 1, consumer_count: 2 });
    expect(closeMock).toHaveBeenCalledTimes(4);
  });
});
