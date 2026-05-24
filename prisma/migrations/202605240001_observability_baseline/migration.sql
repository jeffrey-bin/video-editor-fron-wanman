-- PromptCut Studio P1/P2 external PostgreSQL baseline.
-- Includes persisted projects/assets/jobs plus worker, scheduler and diagnostic observability tables.

CREATE TABLE IF NOT EXISTS "StateMeta" (
  "id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StateMeta_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProjectRecord" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "exportPreset" TEXT NOT NULL,
  "storageRoot" TEXT,
  "deletedAt" TIMESTAMP(3),
  "timeline" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AssetRecord" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER,
  "sha256" TEXT,
  "originalKey" TEXT,
  "proxyKey" TEXT,
  "thumbnailKey" TEXT,
  "waveformKey" TEXT,
  "probeStatus" TEXT,
  "probeError" TEXT,
  "durationMs" INTEGER NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "fps" DOUBLE PRECISION,
  "videoCodec" TEXT,
  "audioCodec" TEXT,
  "filePath" TEXT,
  "thumbnailUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssetRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "JobRecord" (
  "id" TEXT NOT NULL,
  "projectId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "progress" INTEGER NOT NULL,
  "input" JSONB NOT NULL,
  "output" JSONB,
  "error" JSONB,
  "attempts" INTEGER NOT NULL,
  "maxAttempts" INTEGER NOT NULL,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "JobRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WorkerHeartbeatRecord" (
  "runnerId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "commitSha" TEXT,
  "hostname" TEXT,
  "pid" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
  "lastJobStartedAt" TIMESTAMP(3),
  "lastJobFinishedAt" TIMESTAMP(3),
  "currentJobId" TEXT,
  "currentQueue" TEXT,
  "processedJobsTotal" INTEGER NOT NULL DEFAULT 0,
  "failedJobsTotal" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerHeartbeatRecord_pkey" PRIMARY KEY ("runnerId")
);

CREATE TABLE IF NOT EXISTS "SchedulerHeartbeatRecord" (
  "name" TEXT NOT NULL,
  "runnerId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "intervalSeconds" INTEGER NOT NULL,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
  "lastRunStartedAt" TIMESTAMP(3),
  "lastRunFinishedAt" TIMESTAMP(3),
  "lastRunDurationMs" INTEGER,
  "lastScannedRunningJobs" INTEGER NOT NULL DEFAULT 0,
  "lastRepairedJobs" JSONB,
  "lastRequeuedJobs" JSONB,
  "lastMarkedStalledJobs" JSONB,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SchedulerHeartbeatRecord_pkey" PRIMARY KEY ("name")
);

CREATE TABLE IF NOT EXISTS "JobDiagnosticEventRecord" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "projectId" TEXT,
  "type" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "retryable" BOOLEAN NOT NULL,
  "runnerId" TEXT,
  "queue" TEXT,
  "attempt" INTEGER,
  "command" JSONB,
  "stderrPreview" TEXT,
  "stdoutPreview" TEXT,
  "objectKey" TEXT,
  "timelineVersion" INTEGER,
  "traceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobDiagnosticEventRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PendingPlanRecord" (
  "requestId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "timelineVersion" INTEGER NOT NULL,
  "plan" JSONB NOT NULL,
  "state" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "appliedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "PendingPlanRecord_pkey" PRIMARY KEY ("requestId")
);

CREATE TABLE IF NOT EXISTS "ExportFileRecord" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "preset" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT,
  "durationMs" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExportFileRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssetRecord_projectId_idx" ON "AssetRecord"("projectId");
CREATE UNIQUE INDEX IF NOT EXISTS "AssetRecord_projectId_originalKey_key" ON "AssetRecord"("projectId", "originalKey");
CREATE INDEX IF NOT EXISTS "JobRecord_status_leaseExpiresAt_idx" ON "JobRecord"("status", "leaseExpiresAt");
CREATE INDEX IF NOT EXISTS "JobRecord_projectId_idx" ON "JobRecord"("projectId");
CREATE INDEX IF NOT EXISTS "WorkerHeartbeatRecord_role_lastHeartbeatAt_idx" ON "WorkerHeartbeatRecord"("role", "lastHeartbeatAt");
CREATE INDEX IF NOT EXISTS "WorkerHeartbeatRecord_status_idx" ON "WorkerHeartbeatRecord"("status");
CREATE INDEX IF NOT EXISTS "JobDiagnosticEventRecord_jobId_createdAt_idx" ON "JobDiagnosticEventRecord"("jobId", "createdAt");
CREATE INDEX IF NOT EXISTS "JobDiagnosticEventRecord_code_createdAt_idx" ON "JobDiagnosticEventRecord"("code", "createdAt");
CREATE INDEX IF NOT EXISTS "JobDiagnosticEventRecord_projectId_createdAt_idx" ON "JobDiagnosticEventRecord"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "PendingPlanRecord_projectId_state_idx" ON "PendingPlanRecord"("projectId", "state");
CREATE INDEX IF NOT EXISTS "ExportFileRecord_projectId_status_idx" ON "ExportFileRecord"("projectId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "ExportFileRecord_objectKey_key" ON "ExportFileRecord"("objectKey");
