import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn(async () => ({}));
const addMock = vi.fn(async () => undefined);
const closeMock = vi.fn(async () => undefined);
const workerMock = vi.fn();
const workerProcessors = new Map<string, (job: { data: { jobId: string } }) => Promise<void>>();
const redisMocks = vi.hoisted(() => ({
  set: vi.fn<() => Promise<string | undefined>>(async () => "OK"),
  get: vi.fn<() => Promise<string | undefined>>(async () => undefined),
  eval: vi.fn(async () => 1),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
}));
const redisSetMock = redisMocks.set;
const redisGetMock = redisMocks.get;
const redisEvalMock = redisMocks.eval;
const redisConnectMock = redisMocks.connect;
const redisDisconnectMock = redisMocks.disconnect;

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
  Worker: vi.fn((queueName, processor, options) => {
    workerMock(queueName, processor, options);
    workerProcessors.set(queueName, processor);
    return { queueName, close: vi.fn() };
  }),
}));

vi.mock("ioredis", () => ({
  __esModule: true,
  default: vi.fn(() => ({
    connect: redisMocks.connect,
    set: redisMocks.set,
    get: redisMocks.get,
    eval: redisMocks.eval,
    disconnect: redisMocks.disconnect,
  })),
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
    workerMock.mockClear();
    workerProcessors.clear();
    redisSetMock.mockReset().mockResolvedValue("OK");
    redisGetMock.mockReset().mockResolvedValue(undefined);
    redisEvalMock.mockReset().mockResolvedValue(1);
    redisConnectMock.mockClear();
    redisDisconnectMock.mockClear();
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    vi.stubEnv("OBJECT_STORAGE_PROVIDER", "filesystem");
    vi.stubEnv("LLM_PROVIDER", "mock");
    vi.stubEnv("FFMPEG_BIN", join(process.cwd(), "tests/fixtures/fake-ffmpeg.mjs"));
    vi.stubEnv("FFPROBE_BIN", join(process.cwd(), "tests/fixtures/fake-ffprobe.mjs"));
    await Promise.all([chmod(process.env.FFMPEG_BIN!, 0o755), chmod(process.env.FFPROBE_BIN!, 0o755)]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  it("documents a real Prisma/PostgreSQL schema for the external repository", async () => {
    const schema = await readFile(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = await readFile(join(process.cwd(), "prisma/migrations/202605240001_observability_baseline/migration.sql"), "utf8");
    expect(schema).toContain('provider = "postgresql"');
    expect(schema).toContain("model ProjectRecord");
    expect(schema).toContain("model AssetRecord");
    expect(schema).toContain("model JobRecord");
    expect(schema).toContain("model PendingPlanRecord");
    expect(schema).toContain("model ExportFileRecord");
    expect(schema).toContain("model StateMeta");
    expect(schema).toContain("model WorkerHeartbeatRecord");
    expect(schema).toContain("model SchedulerHeartbeatRecord");
    expect(schema).toContain("model JobDiagnosticEventRecord");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "WorkerHeartbeatRecord"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "SchedulerHeartbeatRecord"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "JobDiagnosticEventRecord"');
  });

  it("pins Prisma 6 generation so E2E does not drift to Prisma 7 config semantics", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    const lockJson = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));
    expect(packageJson.scripts.postinstall).toBe("prisma generate");
    expect(packageJson.scripts["prisma:generate"]).toBe("prisma generate");
    expect(packageJson.dependencies["@prisma/client"]).toBe("6.19.0");
    expect(packageJson.devDependencies.prisma).toBe("6.19.0");
    expect(lockJson.packages[""].dependencies["@prisma/client"]).toBe("6.19.0");
    expect(lockJson.packages[""].devDependencies.prisma).toBe("6.19.0");
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
    sendMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } })
      .mockResolvedValueOnce({ ContentLength: 5, Metadata: { sha256: "abc123" }, ContentType: "video/mp4" })
      .mockResolvedValueOnce({});
    const { createObjectStore, S3CompatibleObjectStore } = await import("@/server/storage/object-store");
    const store = createObjectStore();
    expect(store).toBeInstanceOf(S3CompatibleObjectStore);
    await expect(store.putObject("projects/p/assets/a/original/file.mp4", Buffer.from("hello"), { contentType: "video/mp4" })).resolves.toMatchObject({ sizeBytes: 5, contentType: "video/mp4" });
    await expect(store.getObject("projects/p/assets/a/original/file.mp4")).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(store.getSignedUploadUrl("projects/p/assets/a/original/file.mp4")).resolves.toMatchObject({ expiresInSeconds: 600 });
    await expect(store.getSignedDownloadUrl("projects/p/exports/e/out.mp4")).resolves.toMatchObject({ expiresInSeconds: 600 });
    await expect(store.statObject("projects/p/assets/a/original/file.mp4")).resolves.toMatchObject({ sizeBytes: 5, sha256: "abc123", contentType: "video/mp4" });
    await expect(store.deleteObject("projects/p/assets/a/original/file.mp4")).resolves.toBeUndefined();
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

  it("creates external BullMQ workers with configured lease duration", async () => {
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example/promptcut");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    vi.stubEnv("JOB_LEASE_SECONDS", "45");
    const { createPromptCutWorkers } = await import("@/server/workers/promptcut-worker");
    const workers = createPromptCutWorkers();
    expect(workers).toHaveLength(4);
    expect(workerMock).toHaveBeenCalledWith("llm_edit_plan", expect.any(Function), expect.objectContaining({ lockDuration: 45000 }));
    expect(workerMock).toHaveBeenCalledWith("timeline_export", expect.any(Function), expect.objectContaining({ lockDuration: 45000 }));
  });

  it("guards stalled repair loop to external storage mode", async () => {
    const { startStalledJobRepairLoop } = await import("@/server/workers/promptcut-worker");
    expect(() => startStalledJobRepairLoop()).toThrow("requires PROMPTCUT_STATE_DRIVER=external");
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example/promptcut");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    const loop = startStalledJobRepairLoop(60_000);
    loop.stop();
  });

  it("repairs expired leases so another worker instance can retry or mark stalled", async () => {
    const state = await loadPersistent();
    await state.resetPersistentStateForTests();
    await state.addAssetToProject("project_demo", { name: "clip.mp4", type: "video/mp4", bytes: await readFile(join(process.cwd(), "tests/fixtures/minimal-real.mp4")) });
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

  it("requeues repaired leases and lets a worker execute the recovered job", async () => {
    const state = await loadPersistent();
    await state.resetPersistentStateForTests();
    await state.addAssetToProject("project_demo", { name: "clip.mp4", type: "video/mp4", bytes: await readFile(join(process.cwd(), "tests/fixtures/minimal-real.mp4")) });
    const exportJob = await state.createExportJob({ project_id: "project_demo", preset: "1080p_landscape", ignorePendingPlan: true });
    const statePath = join(dir, "state", "promptcut-state.json");
    const database = JSON.parse(await readFile(statePath, "utf8"));
    database.jobs[exportJob.job_id].status = "running";
    database.jobs[exportJob.job_id].progress = 40;
    database.jobs[exportJob.job_id].attempts = 0;
    database.jobs[exportJob.job_id].leaseOwner = "worker-a";
    database.jobs[exportJob.job_id].leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await import("node:fs/promises").then((fs) => fs.writeFile(statePath, `${JSON.stringify(database, null, 2)}\n`));

    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example/promptcut");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    const scheduler = await import("@/server/workers/scheduler-heartbeat");
    scheduler.setStalledRepairLockClientFactoryForTests(() => ({ connect: redisConnectMock, set: redisSetMock, get: redisGetMock, eval: redisEvalMock, disconnect: redisDisconnectMock }));
    const { createPromptCutWorkers, repairAndRequeueStalledJobs } = await import("@/server/workers/promptcut-worker");

    await expect(repairAndRequeueStalledJobs()).resolves.toMatchObject({ repaired_job_ids: [exportJob.job_id], requeued_job_ids: [exportJob.job_id] });
    expect(addMock).toHaveBeenCalledWith("timeline_export", { jobId: exportJob.job_id }, expect.objectContaining({ jobId: exportJob.job_id }));
    createPromptCutWorkers();
    await workerProcessors.get("timeline_export")?.({ data: { jobId: exportJob.job_id } });
    await expect(state.getJob(exportJob.job_id)).resolves.toMatchObject({ status: "succeeded", progress: 100 });
  });

  it("uses promptcut stalled repair distributed lock so only one scheduler instance requeues", async () => {
    const state = await loadPersistent();
    await state.resetPersistentStateForTests();
    await state.addAssetToProject("project_demo", { name: "clip.mp4", type: "video/mp4", bytes: await readFile(join(process.cwd(), "tests/fixtures/minimal-real.mp4")) });
    const exportJob = await state.createExportJob({ project_id: "project_demo", preset: "1080p_landscape", ignorePendingPlan: true });
    const statePath = join(dir, "state", "promptcut-state.json");
    const database = JSON.parse(await readFile(statePath, "utf8"));
    database.jobs[exportJob.job_id].status = "running";
    database.jobs[exportJob.job_id].progress = 40;
    database.jobs[exportJob.job_id].attempts = 0;
    database.jobs[exportJob.job_id].leaseOwner = "worker-a";
    database.jobs[exportJob.job_id].leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await import("node:fs/promises").then((fs) => fs.writeFile(statePath, `${JSON.stringify(database, null, 2)}\n`));

    redisSetMock.mockResolvedValueOnce("OK").mockResolvedValueOnce(undefined);
    redisGetMock.mockResolvedValue("cleanup-worker-a");
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example/promptcut");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    const scheduler = await import("@/server/workers/scheduler-heartbeat");
    scheduler.setStalledRepairLockClientFactoryForTests(() => ({ connect: redisConnectMock, set: redisSetMock, get: redisGetMock, eval: redisEvalMock, disconnect: redisDisconnectMock }));
    const { repairAndRequeueStalledJobs } = await import("@/server/workers/promptcut-worker");
    const [first, second] = await Promise.all([repairAndRequeueStalledJobs(), repairAndRequeueStalledJobs()]);

    expect([first.lock_acquired, second.lock_acquired].sort()).toEqual([false, true]);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith("timeline_export", { jobId: exportJob.job_id }, expect.objectContaining({ jobId: exportJob.job_id }));
    expect(redisSetMock).toHaveBeenCalledWith("promptcut:stalled-repair", expect.any(String), "PX", expect.any(Number), "NX");
    expect(redisEvalMock).toHaveBeenCalledTimes(1);
  });

  it("records scheduler heartbeat failure when the stalled repair loop cannot acquire Redis", async () => {
    vi.useFakeTimers();
    await loadPersistent();
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example/promptcut");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    redisSetMock.mockRejectedValueOnce(new Error("redis unavailable"));
    const scheduler = await import("@/server/workers/scheduler-heartbeat");
    scheduler.setStalledRepairLockClientFactoryForTests(() => ({ connect: redisConnectMock, set: redisSetMock, get: redisGetMock, eval: redisEvalMock, disconnect: redisDisconnectMock }));
    const { startStalledJobRepairLoop } = await import("@/server/workers/promptcut-worker");
    const loop = startStalledJobRepairLoop(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    loop.stop();
    expect(redisSetMock).toHaveBeenCalledWith("promptcut:stalled-repair", expect.any(String), "PX", 60000, "NX");
  });

  it("clears active heartbeat context when a worker job fails", async () => {
    await loadPersistent();
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example/promptcut");
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");
    const scheduler = await import("@/server/workers/scheduler-heartbeat");
    scheduler.setStalledRepairLockClientFactoryForTests(() => ({ connect: redisConnectMock, set: redisSetMock, get: redisGetMock, eval: redisEvalMock, disconnect: redisDisconnectMock }));
    const { createPromptCutWorkers } = await import("@/server/workers/promptcut-worker");
    createPromptCutWorkers();
    await expect(workerProcessors.get("cleanup")?.({ data: { jobId: "missing_job" } })).rejects.toThrow("JOB_NOT_FOUND");
    const { getStateRepository } = await import("@/server/state/repository");
    const database = await getStateRepository().load();
    const heartbeat = Object.values(database.workerHeartbeats)[0];
    expect(heartbeat).not.toHaveProperty("currentJobId");
    expect(heartbeat).not.toHaveProperty("currentQueue");
  });
});
