import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEditOperations, collectProjectContext, dryRunEditPlan } from "@/server/editor/timeline-ops";
import { AVAILABLE_OPERATIONS } from "@/server/editor/operation-schema";
import { EditPlanResponseSchema, LlmEditRequestSchema, type EditPlanResponse } from "@/server/llm/edit-plan-protocol";
import { CodexCliError } from "@/server/llm/codex-cli-provider";
import { generateConfiguredEditPlan, LlmProviderError } from "@/server/llm/provider";
import { buildFfmpegCommand } from "@/server/ffmpeg/command-builder";
import { executeExport } from "@/server/ffmpeg/export-executor";
import { assertProductionStorageIsConfigured, getStorageConfig } from "@/server/storage/config";
import { buildObjectKey, createObjectStore, FilesystemObjectStore } from "@/server/storage/object-store";
import type { ExportPreset, MediaAsset, Project } from "@/types/editor";

export type JobRecord = {
  id: string;
  projectId?: string;
  type: "asset_ingest" | "llm_edit_plan" | "timeline_export" | "cleanup";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "stalled";
  progress: number;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string };
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

type PendingPlan = {
  requestId: string;
  projectId: string;
  timelineVersion: number;
  plan: EditPlanResponse;
  state: "ready" | "stale" | "invalid" | "applied" | "discarded" | "failed";
  provider: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  expiresAt?: string;
};

type ExportFileRecord = {
  id: string;
  projectId: string;
  jobId: string;
  preset: ExportPreset;
  objectKey: string;
  sizeBytes: number;
  sha256?: string;
  durationMs: number;
  status: "succeeded" | "expired" | "deleted";
  expiresAt: string;
  createdAt: string;
};

type PromptCutDatabase = {
  schemaVersion: 1;
  projects: Record<string, Project>;
  assets: Record<string, MediaAsset[]>;
  jobs: Record<string, JobRecord>;
  pendingPlans: Record<string, PendingPlan>;
  exports: Record<string, ExportFileRecord>;
};

const now = () => new Date().toISOString();
const config = getStorageConfig();
const statePath = join(config.runtimeRoot, "state", "promptcut-state.json");
const objectStore = createObjectStore();
let writeQueue = Promise.resolve();

assertProductionStorageIsConfigured(config);

const createDefaultProjectRecord = (): Project => ({
  id: "project_demo",
  name: "旅行 vlog 片段",
  locale: "zh-CN",
  exportPreset: "1080p_landscape",
  storageRoot: "projects/project_demo",
  createdAt: now(),
  updatedAt: now(),
  timeline: {
    version: 1,
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
});

const createEmptyDatabase = (): PromptCutDatabase => {
  const project = createDefaultProjectRecord();
  return { schemaVersion: 1, projects: { [project.id]: project }, assets: { [project.id]: [] }, jobs: {}, pendingPlans: {}, exports: {} };
};

const loadDatabase = async (): Promise<PromptCutDatabase> => {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as PromptCutDatabase;
    return { ...createEmptyDatabase(), ...parsed };
  } catch {
    return createEmptyDatabase();
  }
};

const saveDatabase = async (database: PromptCutDatabase) => {
  await mkdir(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(database, null, 2)}\n`);
  await rename(tmpPath, statePath);
};

const mutateDatabase = async <T>(mutator: (database: PromptCutDatabase) => Promise<T> | T): Promise<T> => {
  const run = async () => {
    const database = await loadDatabase();
    const result = await mutator(database);
    await saveDatabase(database);
    return result;
  };
  const next = writeQueue.then(run, run);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
};

const getProjectFromDb = (database: PromptCutDatabase, projectId = "project_demo") => database.projects[projectId] ?? Object.values(database.projects)[0] ?? createDefaultProjectRecord();
const listAssetsFromDb = (database: PromptCutDatabase, projectId: string) => database.assets[projectId] ?? [];

const putJob = (database: PromptCutDatabase, job: JobRecord) => {
  database.jobs[job.id] = job;
  return job;
};

const toJobError = (error: unknown) => {
  if (error instanceof CodexCliError || error instanceof LlmProviderError) return { code: error.code, message: error.message };
  return { code: "LLM_EDIT_PLAN_FAILED", message: error instanceof Error ? error.message : "Prompt 方案生成失败" };
};

const fileExtensionFor = (file: { name: string; type: string }, isAudio: boolean) => {
  const match = /\.([a-z0-9]+)$/i.exec(file.name);
  if (match?.[1]) return match[1].toLowerCase();
  if (file.type === "video/quicktime") return "mov";
  return isAudio ? "m4a" : "mp4";
};

export const createDefaultProject = async () => mutateDatabase((database) => getProjectFromDb(database));

export const getProject = async (projectId = "project_demo") => {
  const database = await loadDatabase();
  return getProjectFromDb(database, projectId);
};

export const listAssets = async (projectId: string) => {
  const database = await loadDatabase();
  return listAssetsFromDb(database, projectId);
};

export const addAssetToProject = async (projectId: string, file: { name: string; type: string; size?: number; bytes?: ArrayBuffer | Uint8Array }): Promise<MediaAsset> => {
  const bytes = file.bytes ? Buffer.from(file.bytes instanceof ArrayBuffer ? new Uint8Array(file.bytes) : file.bytes) : Buffer.from(`PromptCut media placeholder: ${file.name}\n`);
  const content = bytes.length > 0 ? bytes : Buffer.from(`PromptCut empty upload placeholder: ${file.name}\n`);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const id = `asset_${randomUUID().slice(0, 8)}`;
  const isAudio = file.type.startsWith("audio") || /\.(mp3|wav|m4a)$/i.test(file.name);
  const objectKey = buildObjectKey.originalAsset(projectId, id, sha256, fileExtensionFor(file, isAudio));
  const stored = await objectStore.putObject(objectKey, content);

  return mutateDatabase((database) => {
    const project = getProjectFromDb(database, projectId);
    database.projects[project.id] = project;
    const localPath = objectStore instanceof FilesystemObjectStore ? objectStore.resolveLocalPath(objectKey) : undefined;
    const asset: MediaAsset = {
      id,
      projectId: project.id,
      kind: isAudio ? "audio" : "video",
      originalName: file.name,
      mimeType: file.type || (isAudio ? "audio/mpeg" : "video/mp4"),
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      originalKey: stored.key,
      probeStatus: "succeeded",
      durationMs: isAudio ? 45000 : 24200,
      width: isAudio ? undefined : 1920,
      height: isAudio ? undefined : 1080,
      fps: isAudio ? undefined : 24,
      filePath: localPath,
      thumbnailUrl: isAudio ? undefined : "gradient",
    };
    database.assets[project.id] = [...listAssetsFromDb(database, project.id), asset];
    const videoTrack = project.timeline.tracks.find((track) => track.id === "video_main");
    const voiceTrack = project.timeline.tracks.find((track) => track.id === "audio_voice");
    const targetTrack = isAudio ? voiceTrack : videoTrack;
    if (targetTrack) {
      targetTrack.clips.push({
        id: `${isAudio ? "clip_audio" : "clip_video"}_${id}`,
        trackId: targetTrack.id,
        assetId: asset.id,
        kind: isAudio ? "audio" : "video",
        startMs: 0,
        endMs: asset.durationMs,
        sourceStartMs: 0,
        sourceEndMs: asset.durationMs,
      });
    }
    project.timeline.durationMs = Math.max(project.timeline.durationMs, asset.durationMs);
    project.timeline.version += 1;
    project.updatedAt = now();
    putJob(database, {
      id: `asset_ingest_${asset.id}`,
      projectId: project.id,
      type: "asset_ingest",
      status: "succeeded",
      progress: 100,
      input: { project_id: project.id, object_key: stored.key },
      output: { asset_id: asset.id, object_key: stored.key, size_bytes: stored.sizeBytes, sha256: stored.sha256 },
      attempts: 1,
      maxAttempts: 1,
      createdAt: now(),
      updatedAt: now(),
      startedAt: now(),
      finishedAt: now(),
    });
    return asset;
  });
};

export const getJob = async (jobId: string) => {
  const database = await loadDatabase();
  return database.jobs[jobId] ?? null;
};

export const createAssetUploadIntent = async (input: { project_id: string; file_name: string; mime_type: string; size_bytes: number; sha256?: string }) => {
  const assetId = `asset_${randomUUID().slice(0, 8)}`;
  const isAudio = input.mime_type.startsWith("audio") || /\.(mp3|wav|m4a)$/i.test(input.file_name);
  const objectKey = buildObjectKey.originalAsset(input.project_id, assetId, input.sha256 ?? "pending", fileExtensionFor({ name: input.file_name, type: input.mime_type }, isAudio));
  const upload = await objectStore.getSignedUploadUrl(objectKey);
  await mutateDatabase((database) => {
    const project = getProjectFromDb(database, input.project_id);
    database.projects[project.id] = project;
    const asset: MediaAsset = {
      id: assetId,
      projectId: project.id,
      kind: isAudio ? "audio" : "video",
      originalName: input.file_name,
      mimeType: input.mime_type,
      sizeBytes: input.size_bytes,
      sha256: input.sha256,
      originalKey: objectKey,
      probeStatus: "pending",
      durationMs: 0,
    };
    database.assets[project.id] = [...listAssetsFromDb(database, project.id), asset];
  });
  return { asset_id: assetId, upload_url: upload.uploadUrl, object_key: objectKey, expires_in_seconds: upload.expiresInSeconds };
};

export const completeAssetUpload = async (assetId: string, input: { project_id: string; object_key: string; sha256?: string }) =>
  mutateDatabase((database) => {
    const assets = listAssetsFromDb(database, input.project_id);
    const asset = assets.find((item) => item.id === assetId && item.originalKey === input.object_key);
    if (!asset) throw new Error("ASSET_NOT_FOUND");
    asset.sha256 = input.sha256 ?? asset.sha256;
    asset.probeStatus = "succeeded";
    asset.durationMs = asset.kind === "audio" ? 45000 : 24200;
    asset.width = asset.kind === "audio" ? undefined : 1920;
    asset.height = asset.kind === "audio" ? undefined : 1080;
    asset.fps = asset.kind === "audio" ? undefined : 24;
    if (objectStore instanceof FilesystemObjectStore) asset.filePath = objectStore.resolveLocalPath(input.object_key);
    const project = getProjectFromDb(database, input.project_id);
    const track = project.timeline.tracks.find((item) => item.id === (asset.kind === "audio" ? "audio_voice" : "video_main"));
    if (track && !track.clips.some((clip) => clip.assetId === asset.id)) {
      track.clips.push({
        id: `${asset.kind === "audio" ? "clip_audio" : "clip_video"}_${asset.id}`,
        trackId: track.id,
        assetId: asset.id,
        kind: asset.kind,
        startMs: 0,
        endMs: asset.durationMs,
        sourceStartMs: 0,
        sourceEndMs: asset.durationMs,
      });
      project.timeline.durationMs = Math.max(project.timeline.durationMs, asset.durationMs);
      project.timeline.version += 1;
      project.updatedAt = now();
    }
    const jobId = `asset_ingest_${asset.id}`;
    putJob(database, {
      id: jobId,
      projectId: project.id,
      type: "asset_ingest",
      status: "succeeded",
      progress: 100,
      input,
      output: { asset_id: asset.id, object_key: input.object_key },
      attempts: 1,
      maxAttempts: 1,
      createdAt: now(),
      updatedAt: now(),
      startedAt: now(),
      finishedAt: now(),
    });
    return { asset, job_id: jobId };
  });

export const createPromptEditJob = async (input: {
  project_id: string;
  timeline_version: number;
  prompt: string;
  locale?: "zh-CN" | "ja-JP" | "en-US";
  scope?: { type: "timeline"; start_ms?: number; end_ms?: number };
}) => {
  const requestId = randomUUID();
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const database = await loadDatabase();
  const project = getProjectFromDb(database, input.project_id);
  const assets = listAssetsFromDb(database, project.id);
  const context = collectProjectContext(project);
  const request = LlmEditRequestSchema.parse({
    request_id: requestId,
    project: { project_id: project.id, duration_ms: project.timeline.durationMs, timeline_version: input.timeline_version },
    user_intent: {
      prompt: input.prompt,
      locale: input.locale ?? "zh-CN",
      scope: input.scope ?? { type: "timeline", start_ms: 0, end_ms: project.timeline.durationMs },
    },
    context: { assets, ...context, available_operations: AVAILABLE_OPERATIONS },
    constraints: { max_operations: 50, require_user_confirmation: true, do_not_modify_source_files: true },
  });
  await mutateDatabase((db) => {
    putJob(db, {
      id: jobId,
      projectId: project.id,
      type: "llm_edit_plan",
      status: "running",
      progress: 35,
      input,
      attempts: 1,
      maxAttempts: 1,
      leaseOwner: config.runnerId,
      leaseExpiresAt: new Date(Date.now() + config.jobLeaseSeconds * 1000).toISOString(),
      createdAt: now(),
      updatedAt: now(),
      startedAt: now(),
    });
  });

  let plan: EditPlanResponse;
  try {
    plan = EditPlanResponseSchema.parse(await generateConfiguredEditPlan(request));
  } catch (error) {
    await mutateDatabase((db) => {
      const job = db.jobs[jobId];
      if (!job) return;
      job.status = "failed";
      job.progress = 100;
      job.error = toJobError(error);
      job.output = { request_id: requestId, timeline_version: input.timeline_version, error: job.error };
      job.finishedAt = now();
      job.updatedAt = now();
    });
    return { request_id: requestId, job_id: jobId };
  }

  await mutateDatabase((db) => {
    const latestProject = getProjectFromDb(db, project.id);
    let state: PendingPlan["state"] = latestProject.timeline.version === input.timeline_version ? "ready" : "stale";
    try {
      if (plan.status !== "failed") dryRunEditPlan(latestProject.timeline, plan.operations);
    } catch {
      state = "invalid";
    }
    db.pendingPlans[requestId] = {
      requestId,
      projectId: latestProject.id,
      timelineVersion: input.timeline_version,
      plan,
      state,
      provider: process.env.LLM_PROVIDER ?? "mock",
      prompt: input.prompt,
      createdAt: now(),
      updatedAt: now(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const job = db.jobs[jobId];
    job.status = "succeeded";
    job.progress = 100;
    job.output = { request_id: requestId, plan, timeline_version: input.timeline_version, plan_state: state };
    job.finishedAt = now();
    job.updatedAt = now();
  });
  return { request_id: requestId, job_id: jobId };
};

export const applyPendingPlan = async (projectId: string, input: { request_id: string; timeline_version: number; operation_ids?: string[] }) =>
  mutateDatabase((database) => {
    const project = getProjectFromDb(database, projectId);
    const pending = database.pendingPlans[input.request_id];
    if (!pending || pending.projectId !== projectId) throw new Error("找不到待应用方案");
    if (pending.state !== "ready") throw new Error("方案当前不可应用");
    if (project.timeline.version !== input.timeline_version) {
      const error = new Error("TIMELINE_VERSION_CONFLICT");
      error.name = "TIMELINE_VERSION_CONFLICT";
      throw error;
    }
    if (input.operation_ids) {
      if (input.operation_ids.length === 0) throw new Error("operation_ids 不能为空");
      const ids = new Set(pending.plan.operations.map((operation) => operation.id));
      const invalidIds = input.operation_ids.filter((id) => !ids.has(id));
      if (invalidIds.length > 0) throw new Error(`operation_ids 不存在: ${invalidIds.join(", ")}`);
    }
    const selected = input.operation_ids ? pending.plan.operations.filter((operation) => input.operation_ids?.includes(operation.id)) : pending.plan.operations;
    const result = applyEditOperations(project.timeline, selected, { requestId: input.request_id, summary: pending.plan.summary });
    project.timeline = result.timeline;
    project.updatedAt = now();
    pending.state = "applied";
    pending.appliedAt = now();
    pending.updatedAt = now();
    return { timeline: project.timeline, timeline_version: project.timeline.version, applied_operation_ids: result.appliedOperationIds, warnings: result.warnings };
  });

export const createExportJob = async (input: { project_id: string; preset: ExportPreset; timeline_version?: number; ignorePendingPlan?: boolean }) => {
  const database = await loadDatabase();
  const project = structuredClone(getProjectFromDb(database, input.project_id));
  if (input.timeline_version !== undefined && project.timeline.version !== input.timeline_version) {
    const error = new Error("TIMELINE_VERSION_CONFLICT");
    error.name = "TIMELINE_VERSION_CONFLICT";
    throw error;
  }
  const hasPending = Object.values(database.pendingPlans).some((plan) => plan.projectId === project.id && plan.state === "ready");
  if (hasPending && !input.ignorePendingPlan) {
    const error = new Error("UNCONFIRMED_EDIT_PLAN");
    error.name = "UNCONFIRMED_EDIT_PLAN";
    throw error;
  }
  const exportId = `export_${randomUUID().slice(0, 8)}`;
  const objectKey = buildObjectKey.exportFile(project.id, exportId, input.preset);
  const outputPath = objectStore instanceof FilesystemObjectStore ? objectStore.resolveLocalPath(objectKey) : join(config.runtimeRoot, "temp", exportId, `${input.preset}.mp4`);
  await mkdir(dirname(outputPath), { recursive: true });
  await mutateDatabase((db) => {
    const dbProject = getProjectFromDb(db, project.id);
    dbProject.exportPreset = input.preset;
    dbProject.updatedAt = now();
    putJob(db, {
      id: exportId,
      projectId: project.id,
      type: "timeline_export",
      status: "running",
      progress: 40,
      input: { ...input, timeline_version: project.timeline.version, timeline_snapshot: project.timeline },
      attempts: 1,
      maxAttempts: 2,
      leaseOwner: config.runnerId,
      leaseExpiresAt: new Date(Date.now() + config.jobLeaseSeconds * 1000).toISOString(),
      createdAt: now(),
      updatedAt: now(),
      startedAt: now(),
    });
  });
  try {
    const command = buildFfmpegCommand(project.timeline, input.preset, outputPath, listAssetsFromDb(database, project.id));
    const execution = await executeExport(command);
    const exported = await readFile(outputPath);
    const sha256 = createHash("sha256").update(exported).digest("hex");
    const expiresAt = new Date(Date.now() + config.exportRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    await mutateDatabase((db) => {
      db.exports[exportId] = { id: exportId, projectId: project.id, jobId: exportId, preset: input.preset, objectKey, sizeBytes: execution.sizeBytes, sha256, durationMs: project.timeline.durationMs, status: "succeeded", expiresAt, createdAt: now() };
      const job = db.jobs[exportId];
      job.status = "succeeded";
      job.progress = 100;
      job.output = { export_id: exportId, export_path: outputPath, object_key: objectKey, preset: input.preset, command, duration_ms: project.timeline.durationMs, file_size_bytes: execution.sizeBytes, mode: execution.mode, expires_at: expiresAt };
      job.finishedAt = now();
      job.updatedAt = now();
    });
  } catch (error) {
    await mutateDatabase((db) => {
      const job = db.jobs[exportId];
      job.status = "failed";
      job.progress = 100;
      job.error = { code: "EXPORT_FAILED", message: error instanceof Error ? error.message : "导出失败" };
      job.output = { export_id: exportId, export_path: outputPath, object_key: objectKey, preset: input.preset, duration_ms: project.timeline.durationMs };
      job.finishedAt = now();
      job.updatedAt = now();
    });
  }
  return { job_id: exportId, export_id: exportId };
};

export const getExportDownloadUrl = async (exportId: string) => {
  const database = await loadDatabase();
  const exportFile = database.exports[exportId];
  if (!exportFile || exportFile.status !== "succeeded") throw new Error("EXPORT_NOT_FOUND");
  const signed = await objectStore.getSignedDownloadUrl(exportFile.objectKey);
  return { download_url: signed.downloadUrl, expires_in_seconds: signed.expiresInSeconds };
};

export const cleanupExpiredStorage = async () => {
  const deletedKeys: string[] = [];
  await mutateDatabase(async (database) => {
    const cutoff = Date.now();
    for (const item of Object.values(database.exports)) {
      if (item.status === "succeeded" && new Date(item.expiresAt).getTime() < cutoff) {
        await objectStore.deleteObject(item.objectKey);
        item.status = "expired";
        deletedKeys.push(item.objectKey);
      }
    }
    putJob(database, {
      id: `cleanup_${randomUUID().slice(0, 8)}`,
      type: "cleanup",
      status: "succeeded",
      progress: 100,
      input: { retention: { export_days: config.exportRetentionDays, deleted_project_days: config.deletedProjectRetentionDays } },
      output: { deleted_object_keys: deletedKeys },
      attempts: 1,
      maxAttempts: 3,
      createdAt: now(),
      updatedAt: now(),
      startedAt: now(),
      finishedAt: now(),
    });
  });
  return { deleted_object_keys: deletedKeys };
};

export const resetPersistentStateForTests = async () => {
  await rm(config.runtimeRoot, { recursive: true, force: true });
  await saveDatabase(createEmptyDatabase());
  return getProject();
};
