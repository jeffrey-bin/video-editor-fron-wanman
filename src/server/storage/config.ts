import { join } from "node:path";

export type StateDriver = "durable_fs" | "in_memory_local_dev" | "external";
export type ObjectStorageProvider = "filesystem" | "s3_compatible";

const readInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export type StorageConfig = {
  stateDriver: StateDriver;
  objectStorageProvider: ObjectStorageProvider;
  runtimeRoot: string;
  databaseUrl?: string;
  redisUrl?: string;
  objectStorageBucket?: string;
  objectStorageEndpoint?: string;
  objectStorageRegion?: string;
  objectStorageAccessKeyId?: string;
  objectStorageSecretAccessKey?: string;
  objectStorageForcePathStyle: boolean;
  signedUrlTtlSeconds: number;
  exportRetentionDays: number;
  deletedProjectRetentionDays: number;
  jobLeaseSeconds: number;
  runnerId: string;
};

export const getStorageConfig = (): StorageConfig => ({
  stateDriver: (process.env.PROMPTCUT_STATE_DRIVER as StateDriver | undefined) ?? "durable_fs",
  objectStorageProvider: (process.env.OBJECT_STORAGE_PROVIDER as ObjectStorageProvider | undefined) ?? "filesystem",
  runtimeRoot: process.env.PROMPTCUT_RUNTIME_ROOT ?? join(process.cwd(), ".promptcut-runtime"),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  objectStorageBucket: process.env.OBJECT_STORAGE_BUCKET,
  objectStorageEndpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  objectStorageRegion: process.env.OBJECT_STORAGE_REGION ?? "auto",
  objectStorageAccessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
  objectStorageSecretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  objectStorageForcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
  signedUrlTtlSeconds: readInt(process.env.SIGNED_URL_TTL_SECONDS, 600),
  exportRetentionDays: readInt(process.env.EXPORT_RETENTION_DAYS, 7),
  deletedProjectRetentionDays: readInt(process.env.DELETED_PROJECT_RETENTION_DAYS, 30),
  jobLeaseSeconds: readInt(process.env.JOB_LEASE_SECONDS, 60),
  runnerId: process.env.RUNNER_ID ?? `local-${process.pid}`,
});

export const assertProductionStorageIsConfigured = (config = getStorageConfig()) => {
  if (process.env.NODE_ENV !== "production") return;
  if (config.stateDriver === "in_memory_local_dev") {
    throw new Error("PROMPTCUT_STATE_DRIVER=in_memory_local_dev is forbidden in production");
  }
  if (config.stateDriver === "external" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when PROMPTCUT_STATE_DRIVER=external");
  }
  if (config.stateDriver === "external" && !process.env.REDIS_URL) {
    throw new Error("REDIS_URL is required when PROMPTCUT_STATE_DRIVER=external");
  }
  if (config.objectStorageProvider === "s3_compatible") {
    const required = ["OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) throw new Error(`Missing object storage env: ${missing.join(", ")}`);
  }
};
