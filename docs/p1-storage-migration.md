# PromptCut Studio P1 Storage Migration

## Scope

P1 removes the production dependency on process-local `Map` state and `.promptcut-runtime` as an implicit API state store. API routes now use `src/server/state/persistent.ts`, which persists project state, media metadata, pending edit plans, export records and job records through a repository facade. `src/server/state/in-memory.ts` remains only as the P0 local-dev/test compatibility implementation.

## Runtime Modes

Local development default:

```env
PROMPTCUT_STATE_DRIVER=durable_fs
OBJECT_STORAGE_PROVIDER=filesystem
PROMPTCUT_RUNTIME_ROOT=.promptcut-runtime
SIGNED_URL_TTL_SECONDS=600
EXPORT_RETENTION_DAYS=7
DELETED_PROJECT_RETENTION_DAYS=30
JOB_LEASE_SECONDS=60
RUNNER_ID=local-dev
```

Production target:

```env
PROMPTCUT_STATE_DRIVER=external
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
OBJECT_STORAGE_PROVIDER=s3_compatible
OBJECT_STORAGE_BUCKET=promptcut-prod
OBJECT_STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
OBJECT_STORAGE_ACCESS_KEY_ID=...
OBJECT_STORAGE_SECRET_ACCESS_KEY=...
SIGNED_URL_TTL_SECONDS=600
EXPORT_RETENTION_DAYS=7
DELETED_PROJECT_RETENTION_DAYS=30
JOB_LEASE_SECONDS=60
RUNNER_ID=<hostname-or-uuid>
LLM_PROVIDER=mock
FFMPEG_BIN=ffmpeg
FFPROBE_BIN=ffprobe
```

`PROMPTCUT_STATE_DRIVER=in_memory_local_dev` is rejected when `NODE_ENV=production`.

## Durable Data Boundaries

- Project timeline, asset metadata, pending plans, exports and visible job state are read from the repository facade, not process globals.
- Media and export bytes are addressed by stable object keys under `projects/{projectId}/...`.
- Export jobs store a timeline snapshot in the job input before rendering, so later timeline edits do not change an in-flight export.
- Apply edit plan uses `timeline_version`; stale submissions return `TIMELINE_VERSION_CONFLICT`.
- Cleanup is explicit through `cleanupExpiredStorage()`, marks expired export records and deletes object keys idempotently.

## External Database Migration Shape

When moving the `external` driver from the local durable filesystem implementation to PostgreSQL/Prisma, create tables equivalent to:

- `projects`: id, owner_id, name, locale, timeline JSON, timeline_version, export_preset, storage_root, deleted_at, created_at, updated_at
- `media_assets`: id, project_id, kind, original_name, mime_type, size_bytes, sha256, original_key, proxy_key, thumbnail_key, waveform_key, probe fields, deleted_at, timestamps
- `edit_plans`: request_id, project_id, timeline_version, status, provider, prompt, plan JSON, warnings JSON, raw_output_key, applied_at, expires_at, timestamps
- `jobs`: id, project_id, type, status, progress, input JSON, output JSON, error fields, attempts, max_attempts, lease_owner, lease_expires_at, timestamps
- `export_files`: id, project_id, job_id, preset, object_key, size_bytes, sha256, duration_ms, status, expires_at, deleted_at, created_at

Production multi-instance deployments must back this facade with PostgreSQL and Redis/BullMQ. Redis is a scheduling cache only; PostgreSQL remains the user-visible source of truth and can rebuild queued/stalled jobs.

## Runner Boundary

- `web`: Next.js UI/API, repository access, signed URL creation and job enqueue.
- `media-worker`: FFmpeg/ffprobe, object storage read/write, job heartbeat/progress.
- `llm-worker`: mock/Codex CLI/future LLM provider, edit-plan persistence only.
- `cleanup-worker`: retention cleanup and stalled job repair.

Cloudflare can provide DNS/CDN/R2, but media processing must run on Node.js/container runners with FFmpeg.
