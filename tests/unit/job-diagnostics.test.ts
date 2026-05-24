import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateRepository, resetStateRepositoryForTests } from "@/server/state/repository";

let dir = "";

describe("job diagnostics", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-diagnostics-test-"));
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    vi.stubEnv("RUNNER_ID", "media-worker-test");
    resetStateRepositoryForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetStateRepositoryForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("stores redacted diagnostic events separately from job error", async () => {
    await getStateRepository().mutate((database) => {
      database.jobs.export_1 = {
        id: "export_1",
        projectId: "project_demo",
        type: "timeline_export",
        status: "failed",
        progress: 100,
        input: {},
        error: { code: "FFMPEG_FAILED", message: "ffmpeg exited with code 1" },
        attempts: 1,
        maxAttempts: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    const { writeJobDiagnosticEvent, listJobDiagnostics, classifyJobError } = await import("@/server/observability/diagnostics");
    expect(classifyJobError("render", new Error("ffmpeg exited with code 1"))).toMatchObject({ code: "FFMPEG_FAILED", retryable: true });
    await writeJobDiagnosticEvent({
      jobId: "export_1",
      projectId: "project_demo",
      type: "error",
      phase: "render",
      code: "FFMPEG_FAILED",
      message: "ffmpeg exited with code 1",
      retryable: true,
      queue: "timeline_export",
      command: { bin: "ffmpeg", args_preview: ["-i", "https://r2.example/file?X-Amz-Signature=secret"] },
      stderrPreview: "Authorization: Bearer supersecrettoken123456 failed",
      objectKey: "projects/project_demo/assets/asset_1/original/person-name.mp4",
      timelineVersion: 2,
    });
    const diagnostics = await listJobDiagnostics("export_1");
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ runnerId: "media-worker-test", code: "FFMPEG_FAILED", objectKey: "projects/project_demo/assets/asset_1/original/[REDACTED]" });
    expect(serialized).not.toContain("supersecrettoken123456");
    expect(serialized).not.toContain("X-Amz-Signature");
  });
});
