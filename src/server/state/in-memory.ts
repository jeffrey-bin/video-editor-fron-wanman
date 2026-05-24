import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEditOperations, collectProjectContext, dryRunEditPlan } from "@/server/editor/timeline-ops";
import { AVAILABLE_OPERATIONS } from "@/server/editor/operation-schema";
import { EditPlanResponseSchema, LlmEditRequestSchema, type EditPlanResponse } from "@/server/llm/edit-plan-protocol";
import { CodexCliError } from "@/server/llm/codex-cli-provider";
import { generateConfiguredEditPlan, LlmProviderError } from "@/server/llm/provider";
import { buildFfmpegCommand } from "@/server/ffmpeg/command-builder";
import { executeExport } from "@/server/ffmpeg/export-executor";
import type { ExportPreset, MediaAsset, Project } from "@/types/editor";

export type JobRecord = {
  id: string;
  projectId?: string;
  type: "asset_ingest" | "llm_edit_plan" | "timeline_export";
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
};

type PendingPlan = {
  requestId: string;
  projectId: string;
  timelineVersion: number;
  plan: EditPlanResponse;
  state: "ready" | "stale" | "invalid";
};

const now = () => new Date().toISOString();

type PromptCutState = {
  projects: Map<string, Project>;
  assets: Map<string, MediaAsset[]>;
  jobs: Map<string, JobRecord>;
  pendingPlans: Map<string, PendingPlan>;
};

const stateKey = "__promptcutState";
const globalState = globalThis as typeof globalThis & { [stateKey]?: PromptCutState };
const store =
  globalState[stateKey] ??
  (globalState[stateKey] = {
    projects: new Map<string, Project>(),
    assets: new Map<string, MediaAsset[]>(),
    jobs: new Map<string, JobRecord>(),
    pendingPlans: new Map<string, PendingPlan>(),
  });

const { projects, assets, jobs, pendingPlans } = store;
const runtimeRoot = join(process.cwd(), ".promptcut-runtime");

export const createDefaultProject = () => {
  if (projects.size > 0) return [...projects.values()][0];
  const project: Project = {
    id: "project_demo",
    name: "旅行 vlog 片段",
    locale: "zh-CN",
    exportPreset: "1080p_landscape",
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
  };
  projects.set(project.id, project);
  assets.set(project.id, []);
  return project;
};

export const getProject = (projectId = "project_demo") => projects.get(projectId) ?? createDefaultProject();

export const listAssets = (projectId: string) => assets.get(projectId) ?? [];

export const addAssetToProject = async (projectId: string, file: { name: string; type: string; size?: number; bytes?: ArrayBuffer | Uint8Array }): Promise<MediaAsset> => {
  const project = getProject(projectId);
  const id = `asset_${randomUUID().slice(0, 8)}`;
  const isAudio = file.type.startsWith("audio") || /\.(mp3|wav|m4a)$/i.test(file.name);
  const mediaDir = join(runtimeRoot, "media", projectId, id);
  await mkdir(mediaDir, { recursive: true });
  const extension = isAudio ? "m4a" : "mp4";
  const filePath = join(mediaDir, `original.${extension}`);
  const bytes = file.bytes
    ? Buffer.from(file.bytes instanceof ArrayBuffer ? new Uint8Array(file.bytes) : file.bytes)
    : Buffer.from(`PromptCut local dev media placeholder: ${file.name}\n`);
  await writeFile(filePath, bytes.length > 0 ? bytes : Buffer.from(`PromptCut empty upload placeholder: ${file.name}\n`));
  const asset: MediaAsset = {
    id,
    projectId,
    kind: isAudio ? "audio" : "video",
    originalName: file.name,
    mimeType: file.type || (isAudio ? "audio/mpeg" : "video/mp4"),
    durationMs: isAudio ? 45000 : 24200,
    width: isAudio ? undefined : 1920,
    height: isAudio ? undefined : 1080,
    fps: isAudio ? undefined : 24,
    filePath,
    thumbnailUrl: isAudio ? undefined : "gradient",
  };
  assets.set(projectId, [...listAssets(projectId), asset]);
  const videoTrack = project.timeline.tracks.find((track) => track.id === "video_main");
  const voiceTrack = project.timeline.tracks.find((track) => track.id === "audio_voice");
  const targetTrack = isAudio ? voiceTrack : videoTrack;
  if (targetTrack) {
    targetTrack.clips.push({
      id: isAudio ? "clip_audio_main" : "clip_video_main",
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
  return asset;
};

const putJob = (job: JobRecord) => {
  jobs.set(job.id, job);
  return job;
};

const toJobError = (error: unknown) => {
  if (error instanceof CodexCliError || error instanceof LlmProviderError) {
    return { code: error.code, message: error.message };
  }
  return { code: "LLM_EDIT_PLAN_FAILED", message: error instanceof Error ? error.message : "Prompt 方案生成失败" };
};

export const getJob = (jobId: string) => jobs.get(jobId) ?? null;

export const createPromptEditJob = async (input: {
  project_id: string;
  timeline_version: number;
  prompt: string;
  locale?: "zh-CN" | "ja-JP" | "en-US";
  scope?: { type: "timeline"; start_ms?: number; end_ms?: number };
}) => {
  const project = getProject(input.project_id);
  const requestId = randomUUID();
  const job = putJob({
    id: `job_${randomUUID().slice(0, 8)}`,
    projectId: project.id,
    type: "llm_edit_plan",
    status: "running",
    progress: 35,
    input,
    createdAt: now(),
    updatedAt: now(),
  });
  const context = collectProjectContext(project);
  const request = LlmEditRequestSchema.parse({
    request_id: requestId,
    project: { project_id: project.id, duration_ms: project.timeline.durationMs, timeline_version: input.timeline_version },
    user_intent: {
      prompt: input.prompt,
      locale: input.locale ?? "zh-CN",
      scope: input.scope ?? { type: "timeline", start_ms: 0, end_ms: project.timeline.durationMs },
    },
    context: { assets: listAssets(project.id), ...context, available_operations: AVAILABLE_OPERATIONS },
    constraints: { max_operations: 50, require_user_confirmation: true, do_not_modify_source_files: true },
  });
  let plan: EditPlanResponse;
  try {
    plan = EditPlanResponseSchema.parse(await generateConfiguredEditPlan(request));
  } catch (error) {
    job.status = "failed";
    job.progress = 100;
    job.error = toJobError(error);
    job.output = { request_id: requestId, timeline_version: input.timeline_version, error: job.error };
    job.updatedAt = now();
    return { request_id: requestId, job_id: job.id };
  }
  let state: PendingPlan["state"] = project.timeline.version === input.timeline_version ? "ready" : "stale";
  try {
    if (plan.status !== "failed") dryRunEditPlan(project.timeline, plan.operations);
  } catch {
    state = "invalid";
  }
  pendingPlans.set(requestId, { requestId, projectId: project.id, timelineVersion: input.timeline_version, plan, state });
  job.status = "succeeded";
  job.progress = 100;
  job.output = { request_id: requestId, plan, timeline_version: input.timeline_version, plan_state: state };
  job.updatedAt = now();
  return { request_id: requestId, job_id: job.id };
};

export const applyPendingPlan = (projectId: string, input: { request_id: string; timeline_version: number; operation_ids?: string[] }) => {
  const project = getProject(projectId);
  const pending = pendingPlans.get(input.request_id);
  if (!pending || pending.projectId !== projectId) throw new Error("找不到待应用方案");
  if (pending.state !== "ready") throw new Error("方案当前不可应用");
  if (project.timeline.version !== input.timeline_version) throw new Error("时间线版本已变化，请重新生成方案");
  if (input.operation_ids) {
    if (input.operation_ids.length === 0) throw new Error("operation_ids 不能为空");
    const ids = new Set(pending.plan.operations.map((operation) => operation.id));
    const invalidIds = input.operation_ids.filter((id) => !ids.has(id));
    if (invalidIds.length > 0) throw new Error(`operation_ids 不存在: ${invalidIds.join(", ")}`);
  }
  const selected = input.operation_ids
    ? pending.plan.operations.filter((operation) => input.operation_ids?.includes(operation.id))
    : pending.plan.operations;
  const result = applyEditOperations(project.timeline, selected, {
    requestId: input.request_id,
    summary: pending.plan.summary,
  });
  project.timeline = result.timeline;
  project.updatedAt = now();
  pendingPlans.delete(input.request_id);
  return { timeline: project.timeline, timeline_version: project.timeline.version, applied_operation_ids: result.appliedOperationIds, warnings: result.warnings };
};

export const createExportJob = async (input: { project_id: string; preset: ExportPreset; ignorePendingPlan?: boolean }) => {
  const project = getProject(input.project_id);
  const hasPending = [...pendingPlans.values()].some((plan) => plan.projectId === project.id);
  if (hasPending && !input.ignorePendingPlan) {
    const error = new Error("UNCONFIRMED_EDIT_PLAN");
    error.name = "UNCONFIRMED_EDIT_PLAN";
    throw error;
  }
  const id = `export_${randomUUID().slice(0, 8)}`;
  const outputPath = join(runtimeRoot, "exports", project.id, `${id}.mp4`);
  project.exportPreset = input.preset;
  const job = putJob({
    id,
    projectId: project.id,
    type: "timeline_export",
    status: "running",
    progress: 40,
    input,
    createdAt: now(),
    updatedAt: now(),
  });
  try {
    const command = buildFfmpegCommand(project.timeline, input.preset, outputPath, listAssets(project.id));
    const execution = await executeExport(command);
    job.status = "succeeded";
    job.progress = 100;
    job.output = { export_path: outputPath, preset: input.preset, command, duration_ms: project.timeline.durationMs, file_size_bytes: execution.sizeBytes, mode: execution.mode };
  } catch (error) {
    job.status = "failed";
    job.progress = 100;
    job.error = { code: "EXPORT_FAILED", message: error instanceof Error ? error.message : "导出失败" };
    job.output = { export_path: outputPath, preset: input.preset, duration_ms: project.timeline.durationMs };
  }
  job.updatedAt = now();
  return { job_id: job.id };
};

createDefaultProject();

export const resetInMemoryStateForTests = () => {
  projects.clear();
  assets.clear();
  jobs.clear();
  pendingPlans.clear();
  return createDefaultProject();
};
