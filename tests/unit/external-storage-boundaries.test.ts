import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn(async () => ({}));
const addMock = vi.fn(async () => undefined);
const closeMock = vi.fn(async () => undefined);

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn((input) => ({ kind: "put", input })),
  GetObjectCommand: vi.fn((input) => ({ kind: "get", input })),
  HeadObjectCommand: vi.fn((input) => ({ kind: "head", input })),
  DeleteObjectCommand: vi.fn((input) => ({ kind: "delete", input })),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client, command) => `https://signed.example/${command.input.Key}`),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn(() => ({ add: addMock, close: closeMock })),
}));

let dir = "";

const loadPersistent = async () => {
  vi.resetModules();
  return import("@/server/state/persistent");
};

describe("external storage, S3 and queue boundaries", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-external-test-"));
    sendMock.mockReset();
    addMock.mockClear();
    closeMock.mockClear();
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    vi.stubEnv("OBJECT_STORAGE_PROVIDER", "filesystem");
    vi.stubEnv("LLM_PROVIDER", "mock");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  it("documents a real Prisma/PostgreSQL schema for the external repository", async () => {
    const schema = await readFile(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    expect(schema).toContain('provider = "postgresql"');
    expect(schema).toContain("model ProjectRecord");
    expect(schema).toContain("model AssetRecord");
    expect(schema).toContain("model JobRecord");
    expect(schema).toContain("model PendingPlanRecord");
    expect(schema).toContain("model ExportFileRecord");
    expect(schema).toContain("model StateMeta");
  });

  it("requires database and redis bindings for production external state", async () => {
    const { assertProductionStorageIsConfigured, getStorageConfig } = await import("@/server/storage/config");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertProductionStorageIsConfigured({ ...getStorageConfig(), stateDriver: "external" })).toThrow("DATABASE_URL");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example/promptcut");
    vi.stubEnv("REDIS_URL", "");
    expect(() => assertProductionStorageIsConfigured({ ...getStorageConfig(), stateDriver: "external" })).toThrow("REDIS_URL");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    expect(() => assertProductionStorageIsConfigured({ ...getStorageConfig(), stateDriver: "external", objectStorageProvider: "filesystem" })).not.toThrow();
  });

  it("creates S3/R2 presigned URLs and verifies object metadata", async () => {
    vi.stubEnv("OBJECT_STORAGE_PROVIDER", "s3_compatible");
    vi.stubEnv("OBJECT_STORAGE_BUCKET", "promptcut-assets");
    vi.stubEnv("OBJECT_STORAGE_ENDPOINT", "https://r2.example");
    vi.stubEnv("OBJECT_STORAGE_ACCESS_KEY_ID", "key");
    vi.stubEnv("OBJECT_STORAGE_SECRET_ACCESS_KEY", "secret");
    sendMock.mockResolvedValueOnce({ ContentLength: 5, Metadata: { sha256: "abc123" }, ContentType: "video/mp4" });
    const { createObjectStore, S3CompatibleObjectStore } = await import("@/server/storage/object-store");
    const store = createObjectStore();
    expect(store).toBeInstanceOf(S3CompatibleObjectStore);
    await expect(store.getSignedUploadUrl("projects/p/assets/a/original/file.mp4")).resolves.toMatchObject({ expiresInSeconds: 600 });
    await expect(store.getSignedDownloadUrl("projects/p/exports/e/out.mp4")).resolves.toMatchObject({ expiresInSeconds: 600 });
    await expect(store.statObject("projects/p/assets/a/original/file.mp4")).resolves.toMatchObject({ sizeBytes: 5, sha256: "abc123", contentType: "video/mp4" });
  });

  it("uses BullMQ enqueue for external driver instead of running web request work inline", async () => {
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    const { enqueuePromptCutJob } = await import("@/server/workers/queue");
    const inline = vi.fn(async () => undefined);
    await expect(enqueuePromptCutJob("llm_edit_plan", "job_1", inline)).resolves.toEqual({ mode: "bullmq" });
    expect(inline).not.toHaveBeenCalled();
    expect(addMock).toHaveBeenCalledWith("llm_edit_plan", { jobId: "job_1" }, expect.objectContaining({ jobId: "job_1", attempts: 3 }));
    expect(closeMock).toHaveBeenCalled();
  });

  it("repairs expired leases so another worker instance can retry or mark stalled", async () => {
    const state = await loadPersistent();
    await state.resetPersistentStateForTests();
    const exportJob = await state.createExportJob({ project_id: "project_demo", preset: "1080p_landscape", ignorePendingPlan: true });
    const statePath = join(dir, "state", "promptcut-state.json");
    const database = JSON.parse(await readFile(statePath, "utf8"));
    database.jobs[exportJob.job_id].status = "running";
    database.jobs[exportJob.job_id].attempts = 0;
    database.jobs[exportJob.job_id].leaseOwner = "worker-a";
    database.jobs[exportJob.job_id].leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await import("node:fs/promises").then((fs) => fs.writeFile(statePath, `${JSON.stringify(database, null, 2)}\n`));
    await expect(state.repairStalledJobs()).resolves.toMatchObject({ repaired_job_ids: [exportJob.job_id] });
    expect((await state.getJob(exportJob.job_id))?.status).toBe("queued");
  });
});
