import { afterEach, describe, expect, it, vi } from "vitest";
import { requireOpsAuth } from "@/server/observability/auth";

describe("observability auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows local development without a token", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(requireOpsAuth(new Request("http://local.test/api/metrics"))).toBeNull();
  });

  it("requires and validates bearer token in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await requireOpsAuth(new Request("http://local.test/api/metrics"))?.json())?.error).toBe("OBSERVABILITY_TOKEN_REQUIRED");
    vi.stubEnv("OBSERVABILITY_TOKEN", "ops-secret");
    expect((await requireOpsAuth(new Request("http://local.test/api/metrics", { headers: { authorization: "Bearer wrong" } }))?.json())?.error).toBe("UNAUTHORIZED");
    expect(requireOpsAuth(new Request("http://local.test/api/metrics", { headers: { authorization: "Bearer ops-secret" } }))).toBeNull();
  });
});
