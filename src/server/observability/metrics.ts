import { Queue } from "bullmq";
import { getStorageConfig } from "@/server/storage/config";
import { getStateRepository, type JobRecord } from "@/server/state/repository";
import type { PromptCutQueueName } from "@/server/workers/queue";

const queueNames: PromptCutQueueName[] = ["asset_ingest", "llm_edit_plan", "timeline_export", "cleanup"];
const latencyBuckets = [1, 5, 10, 30, 60, 120, 300, 600, 1800];

export type QueueMetric = {
  name: PromptCutQueueName;
  waiting: number;
  delayed: number;
  active: number;
  completed_last_15m: number;
  failed_last_15m: number;
  stalled_db: number;
  oldest_waiting_age_seconds: number;
  p95_runtime_seconds_last_1h: number;
  p95_queue_wait_seconds_last_1h: number;
  consumer_count: number;
  consistency_warnings: string[];
};

const percentile95 = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

const countRecent = (jobs: JobRecord[], status: JobRecord["status"], sinceMs: number) => jobs.filter((job) => job.status === status && job.finishedAt && new Date(job.finishedAt).getTime() >= sinceMs).length;

const labelValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const pushHistogram = (lines: string[], name: string, labels: Record<string, string>, values: number[]) => {
  const baseLabels = Object.entries(labels).map(([key, value]) => `${key}="${labelValue(value)}"`).join(",");
  let cumulative = 0;
  const sorted = [...values].sort((a, b) => a - b);
  for (const bucket of latencyBuckets) {
    cumulative = sorted.filter((value) => value <= bucket).length;
    lines.push(`${name}_bucket{${baseLabels},le="${bucket}"} ${cumulative}`);
  }
  lines.push(`${name}_bucket{${baseLabels},le="+Inf"} ${sorted.length}`);
  lines.push(`${name}_sum{${baseLabels}} ${sorted.reduce((total, value) => total + value, 0)}`);
  lines.push(`${name}_count{${baseLabels}} ${sorted.length}`);
};

export const collectQueueMetrics = async (): Promise<{ generated_at: string; queues: QueueMetric[] }> => {
  const config = getStorageConfig();
  const database = await getStateRepository().load();
  const nowMs = Date.now();
  const recent15m = nowMs - 15 * 60 * 1000;
  const recent1h = nowMs - 60 * 60 * 1000;
  const queues: QueueMetric[] = [];

  for (const name of queueNames) {
    const dbJobs = Object.values(database.jobs).filter((job) => job.type === name);
    const dbQueued = dbJobs.filter((job) => job.status === "queued");
    const dbRunning = dbJobs.filter((job) => job.status === "running");
    let redis = { waiting: 0, delayed: 0, active: 0, consumer_count: 0 };
    if (config.stateDriver === "external" && config.redisUrl) {
      const queue = new Queue(name, { connection: { url: config.redisUrl } });
      try {
        const counts = await queue.getJobCounts("waiting", "delayed", "active");
        redis = { waiting: counts.waiting ?? 0, delayed: counts.delayed ?? 0, active: counts.active ?? 0, consumer_count: (await queue.getWorkers()).length };
      } finally {
        await queue.close();
      }
    } else {
      redis = { waiting: dbQueued.length, delayed: 0, active: dbRunning.length, consumer_count: Object.values(database.workerHeartbeats).filter((worker) => worker.currentQueue === name).length };
    }

    const queueWaits = dbJobs.filter((job) => job.startedAt && new Date(job.createdAt).getTime() >= recent1h).map((job) => (new Date(job.startedAt!).getTime() - new Date(job.createdAt).getTime()) / 1000);
    const runtimes = dbJobs.filter((job) => job.startedAt && job.finishedAt && new Date(job.finishedAt).getTime() >= recent1h).map((job) => (new Date(job.finishedAt!).getTime() - new Date(job.startedAt!).getTime()) / 1000);
    const oldestQueued = dbQueued.length > 0 ? Math.max(...dbQueued.map((job) => Math.max(0, (nowMs - new Date(job.createdAt).getTime()) / 1000))) : 0;
    const warnings: string[] = [];
    if (config.stateDriver === "external" && dbQueued.length > redis.waiting + redis.delayed) warnings.push("db_queued_jobs_missing_from_redis");
    if (dbRunning.length !== redis.active && config.stateDriver === "external") warnings.push("db_running_jobs_differs_from_redis_active");

    queues.push({
      name,
      waiting: redis.waiting,
      delayed: redis.delayed,
      active: redis.active,
      completed_last_15m: countRecent(dbJobs, "succeeded", recent15m),
      failed_last_15m: countRecent(dbJobs, "failed", recent15m),
      stalled_db: dbJobs.filter((job) => job.status === "stalled").length,
      oldest_waiting_age_seconds: Math.round(oldestQueued),
      p95_runtime_seconds_last_1h: Math.round(percentile95(runtimes)),
      p95_queue_wait_seconds_last_1h: Math.round(percentile95(queueWaits)),
      consumer_count: redis.consumer_count,
      consistency_warnings: warnings,
    });
  }

  return { generated_at: new Date().toISOString(), queues };
};

export const renderPrometheusMetrics = async () => {
  const [queueMetrics, database] = await Promise.all([collectQueueMetrics(), getStateRepository().load()]);
  const lines: string[] = [];
  const nowMs = Date.now();
  const recent1h = nowMs - 60 * 60 * 1000;
  for (const queue of queueMetrics.queues) {
    lines.push(`promptcut_queue_waiting{queue="${queue.name}"} ${queue.waiting}`);
    lines.push(`promptcut_queue_active{queue="${queue.name}"} ${queue.active}`);
    lines.push(`promptcut_queue_delayed{queue="${queue.name}"} ${queue.delayed}`);
    lines.push(`promptcut_queue_failed_total{queue="${queue.name}"} ${queue.failed_last_15m}`);
    lines.push(`promptcut_queue_oldest_waiting_age_seconds{queue="${queue.name}"} ${queue.oldest_waiting_age_seconds}`);
    lines.push(`promptcut_stalled_jobs_total{type="${queue.name}"} ${queue.stalled_db}`);
    const jobs = Object.values(database.jobs).filter((job) => job.type === queue.name);
    pushHistogram(
      lines,
      "promptcut_job_runtime_seconds",
      { type: queue.name },
      jobs.filter((job) => job.startedAt && job.finishedAt && new Date(job.finishedAt).getTime() >= recent1h).map((job) => Math.max(0, (new Date(job.finishedAt!).getTime() - new Date(job.startedAt!).getTime()) / 1000)),
    );
    pushHistogram(
      lines,
      "promptcut_job_queue_wait_seconds",
      { type: queue.name },
      jobs.filter((job) => job.startedAt && new Date(job.createdAt).getTime() >= recent1h).map((job) => Math.max(0, (new Date(job.startedAt!).getTime() - new Date(job.createdAt).getTime()) / 1000)),
    );
  }
  const llmJobs = Object.values(database.jobs).filter((job) => job.type === "llm_edit_plan" && job.startedAt && job.finishedAt && new Date(job.finishedAt).getTime() >= recent1h);
  const providerValues = new Map<string, number[]>();
  for (const job of llmJobs) {
    const input = job.input as { request_id?: string } | undefined;
    const provider = (input?.request_id && database.pendingPlans[input.request_id]?.provider) || process.env.LLM_PROVIDER || "mock";
    providerValues.set(provider, [...(providerValues.get(provider) ?? []), Math.max(0, (new Date(job.finishedAt!).getTime() - new Date(job.startedAt!).getTime()) / 1000)]);
  }
  if (providerValues.size === 0) providerValues.set(process.env.LLM_PROVIDER || "mock", []);
  for (const [provider, values] of providerValues) {
    pushHistogram(lines, "promptcut_llm_provider_latency_seconds", { provider }, values);
  }
  const ffmpegFailures = Object.values(database.diagnostics)
    .flat()
    .filter((event) => event.code === "FFMPEG_FAILED");
  const ffmpegExitCounts = new Map<string, number>();
  for (const event of ffmpegFailures) {
    const match = event.message.match(/(?:exit|code)\s+(\d+)/i);
    const exitCode = match?.[1] ?? "unknown";
    ffmpegExitCounts.set(exitCode, (ffmpegExitCounts.get(exitCode) ?? 0) + 1);
  }
  if (ffmpegExitCounts.size === 0) ffmpegExitCounts.set("none", 0);
  for (const [exitCode, count] of ffmpegExitCounts) {
    lines.push(`promptcut_ffmpeg_exit_total{exit_code="${labelValue(exitCode)}"} ${count}`);
  }
  for (const type of queueNames) {
    for (const status of ["queued", "running", "succeeded", "failed", "stalled"]) {
      const count = Object.values(database.jobs).filter((job) => job.type === type && job.status === status).length;
      lines.push(`promptcut_job_status_total{type="${type}",status="${status}"} ${count}`);
    }
  }
  for (const worker of Object.values(database.workerHeartbeats)) {
    const age = Math.max(0, Math.round((Date.now() - new Date(worker.lastHeartbeatAt).getTime()) / 1000));
    lines.push(`promptcut_worker_heartbeat_age_seconds{runner_id="${worker.runnerId}",role="${worker.role}"} ${age}`);
    lines.push(`promptcut_worker_current_jobs{runner_id="${worker.runnerId}",queue="${worker.currentQueue ?? "none"}"} ${worker.currentJobId ? 1 : 0}`);
  }
  const scheduler = database.schedulerHeartbeats.stalled_repair;
  if (scheduler?.lastRunFinishedAt) {
    const age = Math.max(0, Math.round((Date.now() - new Date(scheduler.lastRunFinishedAt).getTime()) / 1000));
    lines.push(`promptcut_stalled_repair_last_success_age_seconds{runner_id="${scheduler.runnerId}"} ${age}`);
  }
  lines.push("promptcut_secret_redaction_failures_total 0");
  return `${lines.join("\n")}\n`;
};
