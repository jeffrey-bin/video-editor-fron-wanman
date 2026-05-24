import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { getStorageConfig, type StorageConfig } from "@/server/storage/config";
import type { EditPlanResponse } from "@/server/llm/edit-plan-protocol";
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

export type PendingPlan = {
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

export type ExportFileRecord = {
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

export type WorkerHeartbeatRecord = {
  runnerId: string;
  role: "web" | "media-worker" | "llm-worker" | "cleanup-worker" | string;
  status: "healthy" | "stale" | "draining" | "unhealthy";
  version: string;
  commitSha?: string;
  hostname?: string;
  pid?: number;
  startedAt: string;
  lastHeartbeatAt: string;
  lastJobStartedAt?: string;
  lastJobFinishedAt?: string;
  currentJobId?: string;
  currentQueue?: JobRecord["type"];
  processedJobsTotal: number;
  failedJobsTotal: number;
  metadata?: unknown;
  updatedAt: string;
};

export type SchedulerHeartbeatRecord = {
  name: "stalled_repair" | string;
  runnerId: string;
  status: "healthy" | "running" | "failed" | "stale" | "unhealthy";
  intervalSeconds: number;
  lastHeartbeatAt: string;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  lastRunDurationMs?: number;
  lastScannedRunningJobs: number;
  lastRepairedJobs: string[];
  lastRequeuedJobs: string[];
  lastMarkedStalledJobs: string[];
  lastErrorCode?: string;
  lastErrorMessage?: string;
  updatedAt: string;
};

export type JobDiagnosticEventRecord = {
  id: string;
  jobId: string;
  projectId?: string;
  type: "info" | "warning" | "error";
  phase: "enqueue" | "start" | "probe" | "llm_call" | "render" | "upload" | "cleanup" | "repair" | string;
  code: string;
  message: string;
  retryable: boolean;
  runnerId?: string;
  queue?: JobRecord["type"];
  attempt?: number;
  command?: unknown;
  stderrPreview?: string;
  stdoutPreview?: string;
  objectKey?: string;
  timelineVersion?: number;
  traceId?: string;
  createdAt: string;
};

export type PromptCutDatabase = {
  schemaVersion: 1;
  projects: Record<string, Project>;
  assets: Record<string, MediaAsset[]>;
  jobs: Record<string, JobRecord>;
  pendingPlans: Record<string, PendingPlan>;
  exports: Record<string, ExportFileRecord>;
  workerHeartbeats: Record<string, WorkerHeartbeatRecord>;
  schedulerHeartbeats: Record<string, SchedulerHeartbeatRecord>;
  diagnostics: Record<string, JobDiagnosticEventRecord[]>;
};

export type StateRepository = {
  load(): Promise<PromptCutDatabase>;
  mutate<T>(mutator: (database: PromptCutDatabase) => Promise<T> | T): Promise<T>;
  reset(): Promise<void>;
};

const now = () => new Date().toISOString();

export const createDefaultProjectRecord = (): Project => ({
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
      { id: "audio_voice", kind: "audio", name: "人声 Voice", role: "voice", clips: [] },
      { id: "music", kind: "audio", name: "配乐 Music", role: "music", clips: [] },
      { id: "subtitles", kind: "subtitle", name: "字幕", clips: [] },
      { id: "ai_markers", kind: "ai", name: "AI 标记", clips: [] },
    ],
  },
});

export const createEmptyDatabase = (): PromptCutDatabase => {
  const project = createDefaultProjectRecord();
  return { schemaVersion: 1, projects: { [project.id]: project }, assets: { [project.id]: [] }, jobs: {}, pendingPlans: {}, exports: {}, workerHeartbeats: {}, schedulerHeartbeats: {}, diagnostics: {} };
};

export class DurableFsStateRepository implements StateRepository {
  private readonly statePath: string;
  private writeQueue = Promise.resolve();

  constructor(config: StorageConfig = getStorageConfig()) {
    this.statePath = join(config.runtimeRoot, "state", "promptcut-state.json");
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as PromptCutDatabase;
      return { ...createEmptyDatabase(), ...parsed };
    } catch {
      return createEmptyDatabase();
    }
  }

  private async save(database: PromptCutDatabase) {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(tmpPath, this.statePath);
  }

  async mutate<T>(mutator: (database: PromptCutDatabase) => Promise<T> | T) {
    const run = async () => {
      const database = await this.load();
      const result = await mutator(database);
      await this.save(database);
      return result;
    };
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async reset() {
    const config = getStorageConfig();
    await rm(config.runtimeRoot, { recursive: true, force: true });
    await this.save(createEmptyDatabase());
  }
}

/* v8 ignore start -- PostgreSQL transaction behavior is covered by schema/config boundary tests; it requires an external service. */
const toDate = (value?: string) => (value ? new Date(value) : undefined);
const fromDate = (value: Date | null | undefined) => (value ? value.toISOString() : undefined);

export class PrismaStateRepository implements StateRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma = new PrismaClient()) {
    this.prisma = prisma;
  }

  async load() {
    const [projects, assets, jobs, pendingPlans, exports, workerHeartbeats, schedulerHeartbeats, diagnostics] = await Promise.all([
      this.prisma.projectRecord.findMany(),
      this.prisma.assetRecord.findMany(),
      this.prisma.jobRecord.findMany(),
      this.prisma.pendingPlanRecord.findMany(),
      this.prisma.exportFileRecord.findMany(),
      this.prisma.workerHeartbeatRecord.findMany(),
      this.prisma.schedulerHeartbeatRecord.findMany(),
      this.prisma.jobDiagnosticEventRecord.findMany({ orderBy: { createdAt: "asc" } }),
    ]);
    const database = createEmptyDatabase();
    database.projects = {};
    database.assets = {};
    for (const project of projects) {
      database.projects[project.id] = {
        id: project.id,
        name: project.name,
        locale: project.locale as Project["locale"],
        exportPreset: project.exportPreset as ExportPreset,
        storageRoot: project.storageRoot ?? undefined,
        deletedAt: fromDate(project.deletedAt),
        timeline: project.timeline as Project["timeline"],
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      };
      database.assets[project.id] = [];
    }
    if (Object.keys(database.projects).length === 0) {
      const project = createDefaultProjectRecord();
      database.projects[project.id] = project;
      database.assets[project.id] = [];
    }
    for (const asset of assets) {
      const item: MediaAsset = {
        id: asset.id,
        projectId: asset.projectId,
        kind: asset.kind as MediaAsset["kind"],
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes ?? undefined,
        sha256: asset.sha256 ?? undefined,
        originalKey: asset.originalKey ?? undefined,
        proxyKey: asset.proxyKey ?? undefined,
        thumbnailKey: asset.thumbnailKey ?? undefined,
        waveformKey: asset.waveformKey ?? undefined,
        probeStatus: asset.probeStatus as MediaAsset["probeStatus"],
        probeError: asset.probeError ?? undefined,
        durationMs: asset.durationMs,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        fps: asset.fps ?? undefined,
        videoCodec: asset.videoCodec ?? undefined,
        audioCodec: asset.audioCodec ?? undefined,
        filePath: asset.filePath ?? undefined,
        thumbnailUrl: asset.thumbnailUrl ?? undefined,
      };
      database.assets[asset.projectId] = [...(database.assets[asset.projectId] ?? []), item];
    }
    database.jobs = Object.fromEntries(
      jobs.map((job) => [
        job.id,
        {
          id: job.id,
          projectId: job.projectId ?? undefined,
          type: job.type as JobRecord["type"],
          status: job.status as JobRecord["status"],
          progress: job.progress,
          input: job.input,
          output: job.output ?? undefined,
          error: job.error as JobRecord["error"],
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          leaseOwner: job.leaseOwner ?? undefined,
          leaseExpiresAt: fromDate(job.leaseExpiresAt),
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          startedAt: fromDate(job.startedAt),
          finishedAt: fromDate(job.finishedAt),
        },
      ]),
    );
    database.pendingPlans = Object.fromEntries(pendingPlans.map((plan) => [plan.requestId, { requestId: plan.requestId, projectId: plan.projectId, timelineVersion: plan.timelineVersion, plan: plan.plan as EditPlanResponse, state: plan.state as PendingPlan["state"], provider: plan.provider, prompt: plan.prompt, createdAt: plan.createdAt.toISOString(), updatedAt: plan.updatedAt.toISOString(), appliedAt: fromDate(plan.appliedAt), expiresAt: fromDate(plan.expiresAt) }]));
    database.exports = Object.fromEntries(exports.map((item) => [item.id, { id: item.id, projectId: item.projectId, jobId: item.jobId, preset: item.preset as ExportPreset, objectKey: item.objectKey, sizeBytes: item.sizeBytes, sha256: item.sha256 ?? undefined, durationMs: item.durationMs, status: item.status as ExportFileRecord["status"], expiresAt: item.expiresAt.toISOString(), createdAt: item.createdAt.toISOString() }]));
    database.workerHeartbeats = Object.fromEntries(workerHeartbeats.map((item) => [item.runnerId, { runnerId: item.runnerId, role: item.role, status: item.status as WorkerHeartbeatRecord["status"], version: item.version, commitSha: item.commitSha ?? undefined, hostname: item.hostname ?? undefined, pid: item.pid ?? undefined, startedAt: item.startedAt.toISOString(), lastHeartbeatAt: item.lastHeartbeatAt.toISOString(), lastJobStartedAt: fromDate(item.lastJobStartedAt), lastJobFinishedAt: fromDate(item.lastJobFinishedAt), currentJobId: item.currentJobId ?? undefined, currentQueue: item.currentQueue as JobRecord["type"] | undefined, processedJobsTotal: item.processedJobsTotal, failedJobsTotal: item.failedJobsTotal, metadata: item.metadata ?? undefined, updatedAt: item.updatedAt.toISOString() }]));
    database.schedulerHeartbeats = Object.fromEntries(schedulerHeartbeats.map((item) => [item.name, { name: item.name, runnerId: item.runnerId, status: item.status as SchedulerHeartbeatRecord["status"], intervalSeconds: item.intervalSeconds, lastHeartbeatAt: item.lastHeartbeatAt.toISOString(), lastRunStartedAt: fromDate(item.lastRunStartedAt), lastRunFinishedAt: fromDate(item.lastRunFinishedAt), lastRunDurationMs: item.lastRunDurationMs ?? undefined, lastScannedRunningJobs: item.lastScannedRunningJobs, lastRepairedJobs: (item.lastRepairedJobs as string[] | null) ?? [], lastRequeuedJobs: (item.lastRequeuedJobs as string[] | null) ?? [], lastMarkedStalledJobs: (item.lastMarkedStalledJobs as string[] | null) ?? [], lastErrorCode: item.lastErrorCode ?? undefined, lastErrorMessage: item.lastErrorMessage ?? undefined, updatedAt: item.updatedAt.toISOString() }]));
    for (const item of diagnostics) {
      const event: JobDiagnosticEventRecord = { id: item.id, jobId: item.jobId, projectId: item.projectId ?? undefined, type: item.type as JobDiagnosticEventRecord["type"], phase: item.phase, code: item.code, message: item.message, retryable: item.retryable, runnerId: item.runnerId ?? undefined, queue: item.queue as JobRecord["type"] | undefined, attempt: item.attempt ?? undefined, command: item.command ?? undefined, stderrPreview: item.stderrPreview ?? undefined, stdoutPreview: item.stdoutPreview ?? undefined, objectKey: item.objectKey ?? undefined, timelineVersion: item.timelineVersion ?? undefined, traceId: item.traceId ?? undefined, createdAt: item.createdAt.toISOString() };
      database.diagnostics[event.jobId] = [...(database.diagnostics[event.jobId] ?? []), event];
    }
    return database;
  }

  async mutate<T>(mutator: (database: PromptCutDatabase) => Promise<T> | T) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.stateMeta.upsert({ where: { id: "global" }, create: { id: "global", revision: 0 }, update: {} });
        const meta = await tx.stateMeta.findUniqueOrThrow({ where: { id: "global" } });
        const database = await new PrismaStateRepository(tx as unknown as PrismaClient).load();
        const result = await mutator(database);
        await persistDatabase(tx, database);
        const updated = await tx.stateMeta.updateMany({ where: { id: "global", revision: meta.revision }, data: { revision: { increment: 1 } } });
        if (updated.count !== 1) throw new Error("STATE_REVISION_CONFLICT");
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async reset() {
    await this.prisma.$transaction([
      this.prisma.jobDiagnosticEventRecord.deleteMany(),
      this.prisma.schedulerHeartbeatRecord.deleteMany(),
      this.prisma.workerHeartbeatRecord.deleteMany(),
      this.prisma.exportFileRecord.deleteMany(),
      this.prisma.pendingPlanRecord.deleteMany(),
      this.prisma.jobRecord.deleteMany(),
      this.prisma.assetRecord.deleteMany(),
      this.prisma.projectRecord.deleteMany(),
      this.prisma.stateMeta.deleteMany(),
    ]);
  }
}

const persistDatabase = async (tx: Prisma.TransactionClient, database: PromptCutDatabase) => {
  for (const project of Object.values(database.projects)) {
    await tx.projectRecord.upsert({
      where: { id: project.id },
      create: { id: project.id, name: project.name, locale: project.locale, exportPreset: project.exportPreset, storageRoot: project.storageRoot, deletedAt: toDate(project.deletedAt), timeline: project.timeline as Prisma.InputJsonValue, createdAt: new Date(project.createdAt), updatedAt: new Date(project.updatedAt) },
      update: { name: project.name, locale: project.locale, exportPreset: project.exportPreset, storageRoot: project.storageRoot, deletedAt: toDate(project.deletedAt), timeline: project.timeline as Prisma.InputJsonValue, updatedAt: new Date(project.updatedAt) },
    });
  }
  for (const assets of Object.values(database.assets)) {
    for (const asset of assets) {
      await tx.assetRecord.upsert({
        where: { id: asset.id },
        create: { id: asset.id, projectId: asset.projectId, kind: asset.kind, originalName: asset.originalName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256, originalKey: asset.originalKey, proxyKey: asset.proxyKey, thumbnailKey: asset.thumbnailKey, waveformKey: asset.waveformKey, probeStatus: asset.probeStatus, probeError: asset.probeError, durationMs: asset.durationMs, width: asset.width, height: asset.height, fps: asset.fps, videoCodec: asset.videoCodec, audioCodec: asset.audioCodec, filePath: asset.filePath, thumbnailUrl: asset.thumbnailUrl },
        update: { projectId: asset.projectId, kind: asset.kind, originalName: asset.originalName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256, originalKey: asset.originalKey, proxyKey: asset.proxyKey, thumbnailKey: asset.thumbnailKey, waveformKey: asset.waveformKey, probeStatus: asset.probeStatus, probeError: asset.probeError, durationMs: asset.durationMs, width: asset.width, height: asset.height, fps: asset.fps, videoCodec: asset.videoCodec, audioCodec: asset.audioCodec, filePath: asset.filePath, thumbnailUrl: asset.thumbnailUrl },
      });
    }
  }
  for (const job of Object.values(database.jobs)) {
    await tx.jobRecord.upsert({
      where: { id: job.id },
      create: { id: job.id, projectId: job.projectId, type: job.type, status: job.status, progress: job.progress, input: job.input as Prisma.InputJsonValue, output: job.output as Prisma.InputJsonValue, error: job.error as Prisma.InputJsonValue, attempts: job.attempts, maxAttempts: job.maxAttempts, leaseOwner: job.leaseOwner, leaseExpiresAt: toDate(job.leaseExpiresAt), createdAt: new Date(job.createdAt), updatedAt: new Date(job.updatedAt), startedAt: toDate(job.startedAt), finishedAt: toDate(job.finishedAt) },
      update: { projectId: job.projectId, type: job.type, status: job.status, progress: job.progress, input: job.input as Prisma.InputJsonValue, output: job.output as Prisma.InputJsonValue, error: job.error as Prisma.InputJsonValue, attempts: job.attempts, maxAttempts: job.maxAttempts, leaseOwner: job.leaseOwner, leaseExpiresAt: toDate(job.leaseExpiresAt), updatedAt: new Date(job.updatedAt), startedAt: toDate(job.startedAt), finishedAt: toDate(job.finishedAt) },
    });
  }
  for (const plan of Object.values(database.pendingPlans)) {
    await tx.pendingPlanRecord.upsert({
      where: { requestId: plan.requestId },
      create: { requestId: plan.requestId, projectId: plan.projectId, timelineVersion: plan.timelineVersion, plan: plan.plan as Prisma.InputJsonValue, state: plan.state, provider: plan.provider, prompt: plan.prompt, createdAt: new Date(plan.createdAt), updatedAt: new Date(plan.updatedAt), appliedAt: toDate(plan.appliedAt), expiresAt: toDate(plan.expiresAt) },
      update: { projectId: plan.projectId, timelineVersion: plan.timelineVersion, plan: plan.plan as Prisma.InputJsonValue, state: plan.state, provider: plan.provider, prompt: plan.prompt, updatedAt: new Date(plan.updatedAt), appliedAt: toDate(plan.appliedAt), expiresAt: toDate(plan.expiresAt) },
    });
  }
  for (const item of Object.values(database.exports)) {
    await tx.exportFileRecord.upsert({
      where: { id: item.id },
      create: { id: item.id, projectId: item.projectId, jobId: item.jobId, preset: item.preset, objectKey: item.objectKey, sizeBytes: item.sizeBytes, sha256: item.sha256, durationMs: item.durationMs, status: item.status, expiresAt: new Date(item.expiresAt), createdAt: new Date(item.createdAt) },
      update: { projectId: item.projectId, jobId: item.jobId, preset: item.preset, objectKey: item.objectKey, sizeBytes: item.sizeBytes, sha256: item.sha256, durationMs: item.durationMs, status: item.status, expiresAt: new Date(item.expiresAt) },
    });
  }
  for (const item of Object.values(database.workerHeartbeats)) {
    await tx.workerHeartbeatRecord.upsert({
      where: { runnerId: item.runnerId },
      create: { runnerId: item.runnerId, role: item.role, status: item.status, version: item.version, commitSha: item.commitSha, hostname: item.hostname, pid: item.pid, startedAt: new Date(item.startedAt), lastHeartbeatAt: new Date(item.lastHeartbeatAt), lastJobStartedAt: toDate(item.lastJobStartedAt), lastJobFinishedAt: toDate(item.lastJobFinishedAt), currentJobId: item.currentJobId, currentQueue: item.currentQueue, processedJobsTotal: item.processedJobsTotal, failedJobsTotal: item.failedJobsTotal, metadata: item.metadata as Prisma.InputJsonValue, updatedAt: new Date(item.updatedAt) },
      update: { role: item.role, status: item.status, version: item.version, commitSha: item.commitSha, hostname: item.hostname, pid: item.pid, startedAt: new Date(item.startedAt), lastHeartbeatAt: new Date(item.lastHeartbeatAt), lastJobStartedAt: toDate(item.lastJobStartedAt), lastJobFinishedAt: toDate(item.lastJobFinishedAt), currentJobId: item.currentJobId, currentQueue: item.currentQueue, processedJobsTotal: item.processedJobsTotal, failedJobsTotal: item.failedJobsTotal, metadata: item.metadata as Prisma.InputJsonValue },
    });
  }
  for (const item of Object.values(database.schedulerHeartbeats)) {
    await tx.schedulerHeartbeatRecord.upsert({
      where: { name: item.name },
      create: { name: item.name, runnerId: item.runnerId, status: item.status, intervalSeconds: item.intervalSeconds, lastHeartbeatAt: new Date(item.lastHeartbeatAt), lastRunStartedAt: toDate(item.lastRunStartedAt), lastRunFinishedAt: toDate(item.lastRunFinishedAt), lastRunDurationMs: item.lastRunDurationMs, lastScannedRunningJobs: item.lastScannedRunningJobs, lastRepairedJobs: item.lastRepairedJobs as Prisma.InputJsonValue, lastRequeuedJobs: item.lastRequeuedJobs as Prisma.InputJsonValue, lastMarkedStalledJobs: item.lastMarkedStalledJobs as Prisma.InputJsonValue, lastErrorCode: item.lastErrorCode, lastErrorMessage: item.lastErrorMessage },
      update: { runnerId: item.runnerId, status: item.status, intervalSeconds: item.intervalSeconds, lastHeartbeatAt: new Date(item.lastHeartbeatAt), lastRunStartedAt: toDate(item.lastRunStartedAt), lastRunFinishedAt: toDate(item.lastRunFinishedAt), lastRunDurationMs: item.lastRunDurationMs, lastScannedRunningJobs: item.lastScannedRunningJobs, lastRepairedJobs: item.lastRepairedJobs as Prisma.InputJsonValue, lastRequeuedJobs: item.lastRequeuedJobs as Prisma.InputJsonValue, lastMarkedStalledJobs: item.lastMarkedStalledJobs as Prisma.InputJsonValue, lastErrorCode: item.lastErrorCode, lastErrorMessage: item.lastErrorMessage },
    });
  }
  for (const events of Object.values(database.diagnostics)) {
    for (const item of events) {
      await tx.jobDiagnosticEventRecord.upsert({
        where: { id: item.id },
        create: { id: item.id, jobId: item.jobId, projectId: item.projectId, type: item.type, phase: item.phase, code: item.code, message: item.message, retryable: item.retryable, runnerId: item.runnerId, queue: item.queue, attempt: item.attempt, command: item.command as Prisma.InputJsonValue, stderrPreview: item.stderrPreview, stdoutPreview: item.stdoutPreview, objectKey: item.objectKey, timelineVersion: item.timelineVersion, traceId: item.traceId, createdAt: new Date(item.createdAt) },
        update: { projectId: item.projectId, type: item.type, phase: item.phase, code: item.code, message: item.message, retryable: item.retryable, runnerId: item.runnerId, queue: item.queue, attempt: item.attempt, command: item.command as Prisma.InputJsonValue, stderrPreview: item.stderrPreview, stdoutPreview: item.stdoutPreview, objectKey: item.objectKey, timelineVersion: item.timelineVersion, traceId: item.traceId },
      });
    }
  }
};
/* v8 ignore stop */

let repository: StateRepository | undefined;

export const getStateRepository = () => {
  if (repository) return repository;
  const config = getStorageConfig();
  repository = config.stateDriver === "external" ? new PrismaStateRepository() : new DurableFsStateRepository(config);
  return repository;
};

export const resetStateRepositoryForTests = () => {
  repository = undefined;
};
