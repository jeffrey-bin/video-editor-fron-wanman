import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir = "";

const loadHealth = async () => {
  vi.resetModules();
  return import("@/server/observability/health");
};

describe("health checks", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-health-test-"));
    vi.stubEnv("PROMPTCUT_RUNTIME_ROOT", dir);
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "durable_fs");
    vi.stubEnv("OBJECT_STORAGE_PROVIDER", "filesystem");
    vi.stubEnv("PROMPTCUT_RUNNER_ROLE", "media-worker");
    vi.stubEnv("FFMPEG_BIN", join(process.cwd(), "tests/fixtures/fake-ffmpeg.mjs"));
    vi.stubEnv("FFPROBE_BIN", join(process.cwd(), "tests/fixtures/fake-ffprobe.mjs"));
    await Promise.all([chmod(process.env.FFMPEG_BIN!, 0o755), chmod(process.env.FFPROBE_BIN!, 0o755)]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports ready with database, storage and media binaries checked without Redis in durable fs", async () => {
    const { collectReadyHealth } = await loadHealth();
    const health = await collectReadyHealth();
    expect(health.status).toBe("ready");
    expect(health.checks.database.status).toBe("ok");
    expect(health.checks.redis.status).toBe("skipped");
    expect(health.checks.object_storage.status).toBe("ok");
    expect(health.checks.ffmpeg.status).toBe("ok");
  });

  it("marks external mode not ready when Redis is absent and deep health redacts secrets", async () => {
    vi.stubEnv("PROMPTCUT_STATE_DRIVER", "external");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example/promptcut");
    const { collectReadyHealth, collectDeepHealth } = await loadHealth();
    const ready = await collectReadyHealth();
    expect(ready.status).toBe("not_ready");
    expect(ready.checks.redis.status).toBe("failed");
    const deep = await collectDeepHealth();
    expect(deep.secret_redaction.status).toBe("ok");
    expect(deep.secret_redaction.sample).not.toContain("sk-testsecret123456789");
  });
});
