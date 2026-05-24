import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemObjectStore, buildObjectKey } from "@/server/storage/object-store";
import { assertProductionStorageIsConfigured, getStorageConfig } from "@/server/storage/config";

let dir = "";

const loadPersistent = async () => {
  vi.resetModules();
  return import("@/server/state/persistent");
};

describe("P1 persistent storage", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-persistent-test-"));
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    vi.stubEnv("OBJECT_STORAGE_PROVIDER", "filesystem");
    vi.stubEnv("LLM_PROVIDER", "mock");
    vi.stubEnv("FFMPEG_BIN", join(process.cwd(), "tests/fixtures/fake-ffmpeg.mjs"));
    vi.stubEnv("FFPROBE_BIN", join(process.cwd(), "tests/fixtures/fake-ffprobe.mjs"));
    await Promise.all([chmod(process.env.FFMPEG_BIN!, 0o755), chmod(process.env.FFPROBE_BIN!, 0o755)]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists projects, assets, prompt plans, jobs and exports outside process memory", async () => {
    const state = await loadPersistent();
    await state.resetPersistentStateForTests();
    const project = await state.getProject("project_demo");
    const asset = await state.addAssetToProject(project.id, { name: "demo.mp4", type: "video/mp4", bytes: await readFile(join(process.cwd(), "tests/fixtures/minimal-real.mp4")) });
    expect(asset.originalKey).toMatch(/^projects\/project_demo\/assets\/asset_/);
    expect(asset.sha256).toHaveLength(64);
    expect((await state.listAssets(project.id))[0].filePath).toContain("objects/projects/project_demo/assets");

    const reloaded = await loadPersistent();
    const persistedProject = await reloaded.getProject(project.id);
    expect(persistedProject.timeline.version).toBe(project.timeline.version + 1);
    expect((await reloaded.listAssets(project.id)).map((item) => item.id)).toContain(asset.id);

    const promptJob = await reloaded.createPromptEditJob({ project_id: project.id, timeline_version: persistedProject.timeline.version, prompt: "剪掉开头 3 秒并添加字幕", locale: "zh-CN" });
    expect((await reloaded.getJob(promptJob.job_id))?.status).toBe("succeeded");
    await expect(reloaded.applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: persistedProject.timeline.version, operation_ids: [] })).rejects.toThrow("operation_ids 不能为空");
    await expect(reloaded.applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: persistedProject.timeline.version, operation_ids: ["missing"] })).rejects.toThrow("operation_ids 不存在");
    await expect(reloaded.createExportJob({ project_id: project.id, preset: "1080p_landscape", timeline_version: persistedProject.timeline.version })).rejects.toThrow("UNCONFIRMED_EDIT_PLAN");

    await reloaded.applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: persistedProject.timeline.version });
    const appliedProject = await reloaded.getProject(project.id);
    await expect(reloaded.applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: persistedProject.timeline.version })).rejects.toThrow("方案当前不可应用");

    const exportJob = await reloaded.createExportJob({ project_id: project.id, preset: "1080p_landscape", timeline_version: appliedProject.timeline.version });
    const exportRecord = await reloaded.getJob(exportJob.job_id);
    expect(exportRecord?.status).toBe("succeeded");
    const output = exportRecord?.output as { export_path: string; object_key: string; mode: string; file_size_bytes: number };
    expect(output.mode).toBe("ffmpeg");
    expect(output.object_key).toBe(`projects/${project.id}/exports/${exportJob.export_id}/1080p_landscape.mp4`);
    expect((await stat(output.export_path)).size).toBe(output.file_size_bytes);

    const signed = await reloaded.getExportDownloadUrl(exportJob.export_id);
    expect(signed.download_url).toContain(output.object_key);
    expect(signed.expires_in_seconds).toBe(600);

    const statePath = join(dir, "state", "promptcut-state.json");
    const database = JSON.parse(await readFile(statePath, "utf8"));
    database.exports[exportJob.export_id].expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(statePath, `${JSON.stringify(database, null, 2)}\n`);
    const cleanup = await reloaded.cleanupExpiredStorage();
    expect(cleanup.deleted_object_keys).toContain(output.object_key);
  });

  it("returns timeline conflicts and uses export timeline snapshots", async () => {
    const state = await loadPersistent();
    await state.resetPersistentStateForTests();
    const project = await state.getProject("project_demo");
    await state.addAssetToProject(project.id, { name: "demo.mp4", type: "video/mp4", bytes: await readFile(join(process.cwd(), "tests/fixtures/minimal-real.mp4")) });
    const latest = await state.getProject(project.id);
    await expect(state.createExportJob({ project_id: project.id, preset: "1080p_landscape", timeline_version: latest.timeline.version - 1, ignorePendingPlan: true })).rejects.toThrow("TIMELINE_VERSION_CONFLICT");

    const promptJob = await state.createPromptEditJob({ project_id: project.id, timeline_version: latest.timeline.version, prompt: "添加字幕", locale: "zh-CN" });
    await expect(state.applyPendingPlan(project.id, { request_id: promptJob.request_id, timeline_version: latest.timeline.version - 1 })).rejects.toThrow("TIMELINE_VERSION_CONFLICT");

    vi.stubEnv("LLM_PROVIDER", "unsupported");
    const failedPlanJob = await state.createPromptEditJob({ project_id: project.id, timeline_version: latest.timeline.version, prompt: "生成方案", locale: "zh-CN" });
    expect((await state.getJob(failedPlanJob.job_id))?.status).toBe("failed");
    expect(await state.getJob("missing")).toBeNull();

    await state.resetPersistentStateForTests();
    const failedExport = await state.createExportJob({ project_id: project.id, preset: "1080p_landscape", ignorePendingPlan: true });
    expect((await state.getJob(failedExport.job_id))?.status).toBe("failed");
    await expect(state.getExportDownloadUrl("missing")).rejects.toThrow("EXPORT_NOT_FOUND");
  });

  it("supports upload intent, complete-upload, idempotent object delete and production guards", async () => {
    const state = await loadPersistent();
    await state.resetPersistentStateForTests();
    const uploadBytes = Buffer.from("0123456789");
    const uploadSha = createHash("sha256").update(uploadBytes).digest("hex");
    const intent = await state.createAssetUploadIntent({ project_id: "project_demo", file_name: "clip.wav", mime_type: "audio/wav", size_bytes: uploadBytes.byteLength, sha256: uploadSha });
    expect(intent.object_key).toBe(`projects/project_demo/assets/${intent.asset_id}/original/${uploadSha}.wav`);
    const uploadStore = new FilesystemObjectStore(getStorageConfig());
    await uploadStore.putObject(intent.object_key, uploadBytes, { contentType: "audio/wav" });
    await expect(state.completeAssetUpload(intent.asset_id, { project_id: "project_demo", object_key: intent.object_key, sha256: "bad", size_bytes: uploadBytes.byteLength })).rejects.toThrow("OBJECT_CHECKSUM_MISMATCH");
    const completed = await state.completeAssetUpload(intent.asset_id, { project_id: "project_demo", object_key: intent.object_key, sha256: uploadSha, size_bytes: uploadBytes.byteLength, mime_type: "audio/wav" });
    expect(completed.job_id).toBe(`asset_ingest_${intent.asset_id}`);
    expect(completed.asset.probeStatus).toBe("succeeded");
    await expect(state.completeAssetUpload("missing", { project_id: "project_demo", object_key: intent.object_key })).rejects.toThrow("ASSET_NOT_FOUND");
    const movIntent = await state.createAssetUploadIntent({ project_id: "project_demo", file_name: "camera", mime_type: "video/quicktime", size_bytes: 1 });
    expect(movIntent.object_key).toMatch(/pending\.mov$/);

    const store = new FilesystemObjectStore(getStorageConfig());
    const key = buildObjectKey.llmRawOutput("project_demo", "request_1");
    const stored = await store.putObject(key, Buffer.from("raw"));
    expect(stored.sha256).toHaveLength(64);
    expect((await store.getObject(key)).toString()).toBe("raw");
    await store.deleteObject(key);
    await expect(store.deleteObject(key)).resolves.toBeUndefined();

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertProductionStorageIsConfigured({ ...getStorageConfig(), stateDriver: "external", objectStorageProvider: "filesystem" })).toThrow("DATABASE_URL");
    vi.stubEnv("DATABASE_URL", "postgresql://example");
    vi.stubEnv("REDIS_URL", "redis://example");
    expect(() => assertProductionStorageIsConfigured({ ...getStorageConfig(), stateDriver: "external", objectStorageProvider: "filesystem" })).not.toThrow();
    expect(() => assertProductionStorageIsConfigured({ ...getStorageConfig(), stateDriver: "external", objectStorageProvider: "s3_compatible" })).toThrow("Missing object storage env");
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "in_memory_local_dev");
    vi.resetModules();
    await expect(import("@/server/state/persistent")).rejects.toThrow("forbidden in production");
  });
});
