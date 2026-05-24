import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { getStorageConfig, type StorageConfig } from "@/server/storage/config";

export type StoredObject = {
  key: string;
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type ObjectStore = {
  putObject(key: string, bytes: Uint8Array): Promise<StoredObject>;
  getObject(key: string): Promise<Uint8Array>;
  getSignedUploadUrl(key: string, ttlSeconds?: number): Promise<{ uploadUrl: string; expiresInSeconds: number }>;
  getSignedDownloadUrl(key: string, ttlSeconds?: number): Promise<{ downloadUrl: string; expiresInSeconds: number }>;
  deleteObject(key: string): Promise<void>;
  resolveLocalPath?(key: string): string;
};

const safeObjectKey = (key: string) => {
  const normalized = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  if (normalized.startsWith("/") || normalized.includes("..")) throw new Error(`Invalid object key: ${key}`);
  return normalized.replaceAll("\\", "/");
};

export class FilesystemObjectStore implements ObjectStore {
  private readonly root: string;
  private readonly ttl: number;

  constructor(config: StorageConfig = getStorageConfig()) {
    this.root = join(config.runtimeRoot, "objects");
    this.ttl = config.signedUrlTtlSeconds;
  }

  resolveLocalPath(key: string) {
    return join(this.root, safeObjectKey(key));
  }

  async putObject(key: string, bytes: Uint8Array): Promise<StoredObject> {
    const path = this.resolveLocalPath(key);
    await mkdir(dirname(path), { recursive: true });
    const buffer = Buffer.from(bytes);
    await writeFile(path, buffer);
    return { key: safeObjectKey(key), path, sizeBytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex") };
  }

  async getObject(key: string) {
    return readFile(this.resolveLocalPath(key));
  }

  async getSignedUploadUrl(key: string, ttlSeconds = this.ttl) {
    return { uploadUrl: `file://${this.resolveLocalPath(key)}`, expiresInSeconds: ttlSeconds };
  }

  async getSignedDownloadUrl(key: string, ttlSeconds = this.ttl) {
    return { downloadUrl: `file://${this.resolveLocalPath(key)}`, expiresInSeconds: ttlSeconds };
  }

  async deleteObject(key: string) {
    const path = this.resolveLocalPath(key);
    try {
      await stat(path);
    } catch {
      return;
    }
    await rm(path, { force: true });
  }
}

export const createObjectStore = () => {
  const config = getStorageConfig();
  if (config.objectStorageProvider === "s3_compatible") {
    throw new Error("S3/R2 object storage adapter is configured for deployment runner injection; local sandbox uses filesystem adapter");
  }
  return new FilesystemObjectStore(config);
};

export const buildObjectKey = {
  originalAsset: (projectId: string, assetId: string, sha256: string, ext: string) => `projects/${projectId}/assets/${assetId}/original/${sha256}.${ext}`,
  exportFile: (projectId: string, exportId: string, preset: string) => `projects/${projectId}/exports/${exportId}/${preset}.mp4`,
  llmRawOutput: (projectId: string, requestId: string) => `projects/${projectId}/llm-runs/${requestId}/raw-output.txt`,
};
