import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const runtimeRoot = join(process.cwd(), ".promptcut-e2e-runtime");
const statePath = join(runtimeRoot, "state", "promptcut-state.json");
const opsHeaders = { authorization: "Bearer ops-secret" };

const staleIso = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();
const freshIso = () => new Date().toISOString();

const seedObservabilityState = async () => {
  const now = Date.now();
  const state = {
    schemaVersion: 1,
    projects: {
      project_demo: {
        id: "project_demo",
        name: "旅行 vlog 片段",
        locale: "zh-CN",
        exportPreset: "1080p_landscape",
        storageRoot: "projects/project_demo",
        createdAt: new Date(now - 120_000).toISOString(),
        updatedAt: new Date(now - 60_000).toISOString(),
        timeline: {
          version: 3,
          durationMs: 24200,
          history: [],
          tracks: [
            { id: "video_main", kind: "video", name: "视频 1", clips: [] },
            { id: "audio_voice", kind: "audio", name: "音频 1", clips: [] },
            { id: "music", kind: "audio", name: "音乐", clips: [] },
            { id: "subtitles", kind: "subtitle", name: "字幕", clips: [] },
            { id: "ai_markers", kind: "ai", name: "AI 标记", clips: [] },
          ],
        },
      },
    },
    assets: { project_demo: [] },
    jobs: {
      export_observability: {
        id: "export_observability",
        projectId: "project_demo",
        type: "timeline_export",
        status: "failed",
        progress: 100,
        input: { object_key: "projects/project_demo/exports/export_observability/1080p_landscape.mp4" },
        output: { mode: "ffmpeg" },
        error: { code: "FFMPEG_FAILED", message: "ffmpeg exited with code 2" },
        attempts: 2,
        maxAttempts: 2,
        createdAt: new Date(now - 90_000).toISOString(),
        updatedAt: new Date(now - 20_000).toISOString(),
        startedAt: new Date(now - 65_000).toISOString(),
        finishedAt: new Date(now - 20_000).toISOString(),
      },
      export_waiting: {
        id: "export_waiting",
        projectId: "project_demo",
        type: "timeline_export",
        status: "queued",
        progress: 0,
        input: {},
        attempts: 0,
        maxAttempts: 2,
        createdAt: new Date(now - 180_000).toISOString(),
        updatedAt: new Date(now - 180_000).toISOString(),
      },
      llm_observability: {
        id: "llm_observability",
        projectId: "project_demo",
        type: "llm_edit_plan",
        status: "succeeded",
        progress: 100,
        input: { request_id: "request_observability" },
        attempts: 1,
        maxAttempts: 1,
        createdAt: new Date(now - 80_000).toISOString(),
        updatedAt: new Date(now - 35_000).toISOString(),
        startedAt: new Date(now - 65_000).toISOString(),
        finishedAt: new Date(now - 35_000).toISOString(),
      },
      stalled_cleanup: {
        id: "stalled_cleanup",
        type: "cleanup",
        status: "stalled",
        progress: 10,
        input: {},
        attempts: 1,
        maxAttempts: 2,
        leaseOwner: "stale-runner",
        leaseExpiresAt: new Date(now - 120_000).toISOString(),
        createdAt: new Date(now - 240_000).toISOString(),
        updatedAt: new Date(now - 120_000).toISOString(),
        startedAt: new Date(now - 180_000).toISOString(),
      },
    },
    pendingPlans: {
      request_observability: {
        requestId: "request_observability",
        projectId: "project_demo",
        timelineVersion: 3,
        plan: {
          request_id: "00000000-0000-4000-8000-000000000001",
          status: "succeeded",
          summary: "观测性测试方案",
          confidence: 0.9,
          requires_confirmation: true,
          warnings: [],
          operations: [],
          unsupported_intents: [],
        },
        state: "ready",
        provider: "codex-cli",
        prompt: "cut intro",
        createdAt: new Date(now - 35_000).toISOString(),
        updatedAt: new Date(now - 35_000).toISOString(),
      },
    },
    exports: {},
    workerHeartbeats: {
      "media-worker-stale": {
        runnerId: "media-worker-stale",
        role: "media-worker",
        status: "healthy",
        version: "0.1.0",
        hostname: "worker-host",
        pid: 12345,
        startedAt: new Date(now - 900_000).toISOString(),
        lastHeartbeatAt: staleIso(),
        currentJobId: "export_waiting",
        currentQueue: "timeline_export",
        processedJobsTotal: 5,
        failedJobsTotal: 1,
        updatedAt: staleIso(),
      },
    },
    schedulerHeartbeats: {
      stalled_repair: {
        name: "stalled_repair",
        runnerId: "cleanup-worker-stale",
        status: "healthy",
        intervalSeconds: 60,
        lastHeartbeatAt: staleIso(),
        lastRunStartedAt: new Date(now - 500_000).toISOString(),
        lastRunFinishedAt: new Date(now - 480_000).toISOString(),
        lastRunDurationMs: 120,
        lastScannedRunningJobs: 1,
        lastRepairedJobs: ["stalled_cleanup"],
        lastRequeuedJobs: ["stalled_cleanup"],
        lastMarkedStalledJobs: [],
        updatedAt: staleIso(),
      },
    },
    diagnostics: {
      export_observability: [
        {
          id: "diag_observability",
          jobId: "export_observability",
          projectId: "project_demo",
          type: "error",
          phase: "render",
          code: "FFMPEG_FAILED",
          message: "ffmpeg exited with code 2",
          retryable: true,
          runnerId: "media-worker-stale",
          queue: "timeline_export",
          attempt: 2,
          command: {
            bin: "ffmpeg",
            args_preview: ["-i", "https://r2.example/file?X-Amz-Signature=[REDACTED]"],
          },
          stderrPreview: "Authorization: Bearer [REDACTED] failed",
          objectKey: "projects/project_demo/assets/asset_1/original/[REDACTED]",
          timelineVersion: 3,
          traceId: "trace-observability",
          createdAt: freshIso(),
        },
      ],
    },
  };

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await seedObservabilityState();
});

test("observability routes expose real runtime health, auth, stale workers, queues and metrics", async ({ request }) => {
  const live = await request.get("/api/health/live");
  expect(live.ok()).toBe(true);
  await expect(live.json()).resolves.toMatchObject({
    status: "live",
    service: "promptcut-studio",
    role: "web",
  });

  const unauthorized = await request.get("/api/metrics", { headers: { authorization: "Bearer wrong" } });
  expect(unauthorized.status()).toBe(401);
  await expect(unauthorized.json()).resolves.toEqual({ error: "UNAUTHORIZED" });

  const ready = await request.get("/api/health/ready");
  expect(ready.ok()).toBe(true);
  await expect(ready.json()).resolves.toMatchObject({
    status: "ready",
    checks: {
      database: { status: "ok" },
      redis: { status: "skipped" },
      object_storage: { status: "ok" },
    },
  });

  const workers = await request.get("/api/health/workers", { headers: opsHeaders });
  expect(workers.ok()).toBe(true);
  const workerPayload = await workers.json();
  expect(workerPayload.workers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runnerId: "media-worker-stale",
        status: "stale",
        currentJobId: "export_waiting",
        currentQueue: "timeline_export",
      }),
    ]),
  );
  expect(workerPayload.scheduler).toMatchObject({
    status: "stale",
    last_repair_result: {
      repaired_job_ids: ["stalled_cleanup"],
      requeued_job_ids: ["stalled_cleanup"],
    },
  });

  const queues = await request.get("/api/ops/queues", { headers: opsHeaders });
  expect(queues.ok()).toBe(true);
  const queuePayload = await queues.json();
  expect(queuePayload.queues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "timeline_export",
        waiting: 1,
        failed_last_15m: 1,
        consumer_count: 1,
      }),
      expect.objectContaining({
        name: "cleanup",
        stalled_db: 1,
      }),
    ]),
  );

  const metrics = await request.get("/api/metrics", { headers: opsHeaders });
  expect(metrics.ok()).toBe(true);
  expect(metrics.headers()["content-type"]).toContain("text/plain");
  const text = await metrics.text();
  expect(text).toContain('promptcut_queue_waiting{queue="timeline_export"} 1');
  expect(text).toContain('promptcut_job_runtime_seconds_bucket{type="timeline_export",le="30"} 1');
  expect(text).toContain('promptcut_job_queue_wait_seconds_bucket{type="timeline_export",le="30"} 1');
  expect(text).toContain('promptcut_llm_provider_latency_seconds_bucket{provider="codex-cli",le="30"} 1');
  expect(text).toContain('promptcut_ffmpeg_exit_total{exit_code="2"} 1');
  expect(text).toContain('promptcut_worker_heartbeat_age_seconds{runner_id="media-worker-stale",role="media-worker"}');
  expect(text).toContain("promptcut_secret_redaction_failures_total 0");
});

test("deep health degrades on storage failure and diagnostics stay redacted", async ({ request }) => {
  const objectRoot = join(runtimeRoot, "objects");
  await rm(objectRoot, { recursive: true, force: true });
  await writeFile(objectRoot, "not a directory", "utf8");
  const degraded = await request.get("/api/health/ready");
  expect(degraded.ok()).toBe(true);
  await expect(degraded.json()).resolves.toMatchObject({
    status: "degraded",
    checks: {
      object_storage: { status: "failed" },
    },
  });
  await rm(objectRoot, { force: true });
  await mkdir(objectRoot, { recursive: true });

  const deep = await request.get("/api/health/deep", { headers: opsHeaders });
  expect(deep.ok()).toBe(true);
  const deepPayload = await deep.json();
  expect(deepPayload.secret_redaction).toMatchObject({ status: "ok" });
  expect(deepPayload.secret_redaction.sample).toContain("[REDACTED]");
  expect(JSON.stringify(deepPayload)).not.toContain("sk-testsecret123456789");
  expect(JSON.stringify(deepPayload)).not.toContain("tokentest123456789");

  const diagnostics = await request.get("/api/jobs/export_observability/diagnostics", { headers: opsHeaders });
  expect(diagnostics.ok()).toBe(true);
  const diagnosticPayload = await diagnostics.json();
  expect(diagnosticPayload.job).toMatchObject({
    id: "export_observability",
    type: "timeline_export",
    status: "failed",
    error: { code: "FFMPEG_FAILED" },
  });
  expect(diagnosticPayload.diagnostics).toEqual([
    expect.objectContaining({
      code: "FFMPEG_FAILED",
      retryable: true,
      objectKey: "projects/project_demo/assets/asset_1/original/[REDACTED]",
      stderrPreview: "Authorization: Bearer [REDACTED] failed",
    }),
  ]);
  const serialized = JSON.stringify(diagnosticPayload);
  expect(serialized).not.toContain("X-Amz-Signature=secret");
  expect(serialized).not.toContain("Bearer supersecret");

  const missing = await request.get("/api/jobs/missing_job/diagnostics", { headers: opsHeaders });
  expect(missing.status()).toBe(404);
  await expect(missing.json()).resolves.toEqual({ error: "JOB_NOT_FOUND" });
});
