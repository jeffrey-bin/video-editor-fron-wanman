import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEditOperations, collectProjectContext, dryRunEditPlan } from "@/server/editor/timeline-ops";
import { AVAILABLE_OPERATIONS } from "@/server/editor/operation-schema";
import { EditPlanResponseSchema, LlmEditRequestSchema, type EditPlanResponse } from "@/server/llm/edit-plan-protocol";
import { CodexCliError } from "@/server/llm/codex-cli-provider";
import { generateConfiguredEditPlan, LlmProviderError } from "@/server/llm/provider";
import { buildFfmpegCommand } from "@/server/ffmpeg/command-builder";
import { executeExport } from "@/server/ffmpeg/export-executor";
import { classifyJobError, writeJobDiagnosticEvent } from "@/server/observability/diagnostics";
import { assertProductionStorageIsConfigured, getStorageConfig } from "@/server/storage/config";
import { buildObjectKey, createObjectStore, FilesystemObjectStore } from "@/server/storage/object-store";
import { createDefaultProjectRecord, getStateRepository, type JobRecord, type PendingPlan, type PromptCutDatabase } from "@/server/state/repository";
import { enqueuePromptCutJob } from "@/server/workers/queue";
import type { ExportPreset, MediaAsset, Project } from "@/types/editor";

const now = () => new Date().toISOString();
const config = getStorageConfig();
const objectStore = createObjectStore();
const repository = getStateRepository();

assertProductionStorageIsConfigured(config);
const loadDatabase = () => repository.load();
const mutateDatabase = <T>(mutator: (database: PromptCutDatabase) => Promise<T> | T): Promise<T> => repository.mutate(mutator);

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
  const stored = await objectStore.putObject(objectKey, content, { contentType: file.type });

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

export const completeAssetUpload = async (assetId: string, input: { project_id: string; object_key: string; sha256?: string; size_bytes?: number; mime_type?: string }) => {
  const stored = await objectStore.statObject(input.object_key);
  if (input.size_bytes !== undefined && stored.sizeBytes !== input.size_bytes) throw new Error("OBJECT_SIZE_MISMATCH");
  if (input.sha256 !== undefined && stored.sha256 !== input.sha256) throw new Error("OBJECT_CHECKSUM_MISMATCH");
  return mutateDatabase((database) => {
    const assets = listAssetsFromDb(database, input.project_id);
    const asset = assets.find((item) => item.id === assetId && item.originalKey === input.object_key);
    if (!asset) throw new Error("ASSET_NOT_FOUND");
    if (asset.sizeBytes !== undefined && asset.sizeBytes !== stored.sizeBytes) throw new Error("OBJECT_SIZE_MISMATCH");
    if (asset.sha256 !== undefined && asset.sha256 !== stored.sha256) throw new Error("OBJECT_CHECKSUM_MISMATCH");
    if (input.mime_type && asset.mimeType !== input.mime_type) throw new Error("OBJECT_CONTENT_TYPE_MISMATCH");
    asset.sizeBytes = stored.sizeBytes;
    asset.sha256 = stored.sha256;
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
      output: { asset_id: asset.id, object_key: input.object_key, size_bytes: stored.sizeBytes, sha256: stored.sha256 },
      attempts: 1,
      maxAttempts: 1,
      createdAt: now(),
      updatedAt: now(),
      startedAt: now(),
      finishedAt: now(),
    });
    return { asset, job_id: jobId };
  });
};

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
      status: "queued",
      progress: 0,
      input: { ...input, request_id: requestId, request },
      attempts: 0,
      maxAttempts: 1,
      createdAt: now(),
      updatedAt: now(),
    });
  });
  await enqueuePromptCutJob("llm_edit_plan", jobId, () => processPromptEditJob(jobId));
  return { request_id: requestId, job_id: jobId };
};

export const processPromptEditJob = async (jobId: string) => {
  const database = await loadDatabase();
  const job = database.jobs[jobId];
  if (!job || job.type !== "llm_edit_plan") throw new Error("JOB_NOT_FOUND");
  const input = job.input as {
    project_id: string;
    timeline_version: number;
    prompt: string;
    request_id: string;
    request: unknown;
  };
  await mutateDatabase((db) => {
    const current = db.jobs[jobId];
    if (!current) return;
    current.status = "running";
    current.progress = 35;
    current.attempts += 1;
    current.leaseOwner = config.runnerId;
    current.leaseExpiresAt = new Date(Date.now() + config.jobLeaseSeconds * 1000).toISOString();
    current.startedAt = current.startedAt ?? now();
    current.updatedAt = now();
  });
  let plan: EditPlanResponse;
  try {
    plan = EditPlanResponseSchema.parse(await generateConfiguredEditPlan(LlmEditRequestSchema.parse(input.request)));
  } catch (error) {
    const diagnostic = classifyJobError("llm_call", error);
    await mutateDatabase((db) => {
      const job = db.jobs[jobId];
      if (!job) return;
      job.status = "failed";
      job.progress = 100;
      job.error = { code: diagnostic.code, message: toJobError(error).message };
      job.output = { request_id: input.request_id, timeline_version: input.timeline_version, error: job.error };
      job.finishedAt = now();
      job.updatedAt = now();
    });
    await writeJobDiagnosticEvent({
      jobId,
      projectId: input.project_id,
      type: "error",
      phase: diagnostic.phase,
      code: diagnostic.code,
      message: error instanceof Error ? error.message : "Prompt 方案生成失败",
      retryable: diagnostic.retryable,
      queue: "llm_edit_plan",
      attempt: job.attempts + 1,
      timelineVersion: input.timeline_version,
      stderrPreview: error,
    });
    return;
  }

  await mutateDatabase((db) => {
    const latestProject = getProjectFromDb(db, input.project_id);
    let state: PendingPlan["state"] = latestProject.timeline.version === input.timeline_version ? "ready" : "stale";
    try {
      if (plan.status !== "failed") dryRunEditPlan(latestProject.timeline, plan.operations);
    } catch {
      state = "invalid";
    }
    db.pendingPlans[input.request_id] = {
      requestId: input.request_id,
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
    job.output = { request_id: input.request_id, plan, timeline_version: input.timeline_version, plan_state: state };
    job.finishedAt = now();
    job.updatedAt = now();
  });
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
  await mutateDatabase((db) => {
    const dbProject = getProjectFromDb(db, project.id);
    dbProject.exportPreset = input.preset;
    dbProject.updatedAt = now();
    putJob(db, {
      id: exportId,
      projectId: project.id,
      type: "timeline_export",
      status: "queued",
      progress: 0,
      input: { ...input, object_key: objectKey, timeline_version: project.timeline.version, timeline_snapshot: project.timeline },
      attempts: 0,
      maxAttempts: 2,
      createdAt: now(),
      updatedAt: now(),
    });
  });
  await enqueuePromptCutJob("timeline_export", exportId, () => processExportJob(exportId));
  return { job_id: exportId, export_id: exportId };
};

export const processExportJob = async (jobId: string) => {
  const database = await loadDatabase();
  const jobRecord = database.jobs[jobId];
  if (!jobRecord || jobRecord.type !== "timeline_export") throw new Error("JOB_NOT_FOUND");
  const input = jobRecord.input as { project_id: string; preset: ExportPreset; object_key: string; timeline_version: number; timeline_snapshot: Project["timeline"] };
  const project = structuredClone(getProjectFromDb(database, input.project_id));
  project.timeline = input.timeline_snapshot;
  const objectKey = input.object_key;
  const outputPath = objectStore instanceof FilesystemObjectStore ? objectStore.resolveLocalPath(objectKey) : join(config.runtimeRoot, "temp", jobId, `${input.preset}.mp4`);
  await mkdir(dirname(outputPath), { recursive: true });
  await mutateDatabase((db) => {
    const job = db.jobs[jobId];
    if (!job) return;
    job.status = "running";
    job.progress = 40;
    job.attempts += 1;
    job.leaseOwner = config.runnerId;
    job.leaseExpiresAt = new Date(Date.now() + config.jobLeaseSeconds * 1000).toISOString();
    job.startedAt = job.startedAt ?? now();
    job.updatedAt = now();
  });
  try {
    const command = buildFfmpegCommand(project.timeline, input.preset, outputPath, listAssetsFromDb(database, project.id));
    const execution = await executeExport(command);
    const exported = await readFile(outputPath);
    const sha256 = createHash("sha256").update(exported).digest("hex");
    if (!(objectStore instanceof FilesystemObjectStore)) await objectStore.putObject(objectKey, exported, { contentType: "video/mp4" });
    const expiresAt = new Date(Date.now() + config.exportRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    await mutateDatabase((db) => {
      db.exports[jobId] = { id: jobId, projectId: project.id, jobId, preset: input.preset, objectKey, sizeBytes: execution.sizeBytes, sha256, durationMs: project.timeline.durationMs, status: "succeeded", expiresAt, createdAt: now() };
      const job = db.jobs[jobId];
      job.status = "succeeded";
      job.progress = 100;
      job.output = { export_id: jobId, export_path: outputPath, object_key: objectKey, preset: input.preset, command, duration_ms: project.timeline.durationMs, file_size_bytes: execution.sizeBytes, mode: execution.mode, expires_at: expiresAt };
      job.finishedAt = now();
      job.updatedAt = now();
    });
  } catch (error) {
    const diagnostic = classifyJobError("render", error);
    await mutateDatabase((db) => {
      const job = db.jobs[jobId];
      job.status = "failed";
      job.progress = 100;
      job.error = { code: diagnostic.code, message: error instanceof Error ? error.message : "导出失败" };
      job.output = { export_id: jobId, export_path: outputPath, object_key: objectKey, preset: input.preset, duration_ms: project.timeline.durationMs };
      job.finishedAt = now();
      job.updatedAt = now();
    });
    await writeJobDiagnosticEvent({
      jobId,
      projectId: project.id,
      type: "error",
      phase: diagnostic.phase,
      code: diagnostic.code,
      message: error instanceof Error ? error.message : "导出失败",
      retryable: diagnostic.retryable,
      queue: "timeline_export",
      attempt: jobRecord.attempts + 1,
      objectKey,
      timelineVersion: input.timeline_version,
      stderrPreview: error,
    });
  }
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

export const repairStalledJobs = async () =>
  mutateDatabase((database) => {
    const repaired: string[] = [];
    const cutoff = Date.now();
    for (const job of Object.values(database.jobs)) {
      if (job.status === "running" && job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() < cutoff) {
        if (job.attempts < job.maxAttempts) {
          job.status = "queued";
          job.progress = 0;
          job.leaseOwner = undefined;
          job.leaseExpiresAt = undefined;
        } else {
          job.status = "stalled";
          job.error = { code: "JOB_LEASE_EXPIRED", message: "Job lease expired and max attempts were exhausted" };
          job.finishedAt = now();
          database.diagnostics[job.id] = [
            ...(database.diagnostics[job.id] ?? []),
            {
              id: `diag_${randomUUID().slice(0, 12)}`,
              jobId: job.id,
              projectId: job.projectId,
              type: "error",
              phase: "repair",
              code: "JOB_LEASE_EXPIRED",
              message: "Job lease expired and max attempts were exhausted",
              retryable: false,
              runnerId: config.runnerId,
              queue: job.type,
              attempt: job.attempts,
              createdAt: now(),
            },
          ];
        }
        job.updatedAt = now();
        repaired.push(job.id);
      }
    }
    return { repaired_job_ids: repaired };
  });

export const processQueuedJob = async (jobId: string) => {
  const job = await getJob(jobId);
  if (!job) throw new Error("JOB_NOT_FOUND");
  if (job.type === "llm_edit_plan") return processPromptEditJob(jobId);
  if (job.type === "timeline_export") return processExportJob(jobId);
  throw new Error(`Unsupported queued job type: ${job.type}`);
};

export const resetPersistentStateForTests = async () => {
  await repository.reset();
  return getProject();
};
