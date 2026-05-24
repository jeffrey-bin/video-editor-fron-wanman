import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getStorageConfig, type StorageConfig } from "@/server/storage/config";

export type StoredObject = {
  key: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  contentType?: string;
};

export type ObjectStore = {
  putObject(key: string, bytes: Uint8Array, options?: { contentType?: string }): Promise<StoredObject>;
  getObject(key: string): Promise<Uint8Array>;
  statObject(key: string): Promise<StoredObject>;
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

  async putObject(key: string, bytes: Uint8Array, options?: { contentType?: string }): Promise<StoredObject> {
    const path = this.resolveLocalPath(key);
    await mkdir(dirname(path), { recursive: true });
    const buffer = Buffer.from(bytes);
    await writeFile(path, buffer);
    return { key: safeObjectKey(key), path, sizeBytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex"), contentType: options?.contentType };
  }

  async getObject(key: string) {
    return readFile(this.resolveLocalPath(key));
  }

  async statObject(key: string) {
    const bytes = await this.getObject(key);
    return { key: safeObjectKey(key), path: this.resolveLocalPath(key), sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
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

export class S3CompatibleObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttl: number;

  constructor(config: StorageConfig = getStorageConfig()) {
    if (!config.objectStorageBucket || !config.objectStorageEndpoint || !config.objectStorageAccessKeyId || !config.objectStorageSecretAccessKey) {
      throw new Error("S3/R2 object storage is missing bucket, endpoint or credentials");
    }
    this.bucket = config.objectStorageBucket;
    this.ttl = config.signedUrlTtlSeconds;
    this.client = new S3Client({
      endpoint: config.objectStorageEndpoint,
      region: config.objectStorageRegion,
      forcePathStyle: config.objectStorageForcePathStyle,
      credentials: {
        accessKeyId: config.objectStorageAccessKeyId,
        secretAccessKey: config.objectStorageSecretAccessKey,
      },
    });
  }

  async putObject(key: string, bytes: Uint8Array, options?: { contentType?: string }) {
    const objectKey = safeObjectKey(key);
    const body = Buffer.from(bytes);
    const sha256 = createHash("sha256").update(body).digest("hex");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: options?.contentType,
        Metadata: { sha256 },
      }),
    );
    return { key: objectKey, path: `s3://${this.bucket}/${objectKey}`, sizeBytes: body.byteLength, sha256, contentType: options?.contentType };
  }

  async getObject(key: string) {
    const objectKey = safeObjectKey(key);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    if (!response.Body) throw new Error(`Object body is empty: ${objectKey}`);
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async statObject(key: string) {
    const objectKey = safeObjectKey(key);
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    const sha256 = head.Metadata?.sha256;
    if (!sha256) {
      const bytes = await this.getObject(objectKey);
      return { key: objectKey, path: `s3://${this.bucket}/${objectKey}`, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: head.ContentType };
    }
    return { key: objectKey, path: `s3://${this.bucket}/${objectKey}`, sizeBytes: head.ContentLength ?? 0, sha256, contentType: head.ContentType };
  }

  async getSignedUploadUrl(key: string, ttlSeconds = this.ttl) {
    const objectKey = safeObjectKey(key);
    const uploadUrl = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: objectKey }), { expiresIn: ttlSeconds });
    return { uploadUrl, expiresInSeconds: ttlSeconds };
  }

  async getSignedDownloadUrl(key: string, ttlSeconds = this.ttl) {
    const objectKey = safeObjectKey(key);
    const downloadUrl = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }), { expiresIn: ttlSeconds });
    return { downloadUrl, expiresInSeconds: ttlSeconds };
  }

  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeObjectKey(key) }));
  }
}

export const createObjectStore = () => {
  const config = getStorageConfig();
  if (config.objectStorageProvider === "s3_compatible") {
    return new S3CompatibleObjectStore(config);
  }
  return new FilesystemObjectStore(config);
};

export const buildObjectKey = {
  originalAsset: (projectId: string, assetId: string, sha256: string, ext: string) => `projects/${projectId}/assets/${assetId}/original/${sha256}.${ext}`,
  exportFile: (projectId: string, exportId: string, preset: string) => `projects/${projectId}/exports/${exportId}/${preset}.mp4`,
  llmRawOutput: (projectId: string, requestId: string) => `projects/${projectId}/llm-runs/${requestId}/raw-output.txt`,
};
