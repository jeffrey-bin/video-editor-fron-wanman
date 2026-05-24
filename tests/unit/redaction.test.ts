import { describe, expect, it } from "vitest";
import { containsUnredactedSecret, redactAndTruncate, redactString, redactValue } from "@/server/observability/redaction";

describe("secret redaction", () => {
  it("redacts database, redis and signed URL credentials", () => {
    const input = "postgresql://user:pass@db.example/promptcut?ssl=true redis://:secret@redis.example:6379 https://r2.example/object?X-Amz-Signature=abc&X-Amz-Credential=secret";
    const output = redactString(input);
    expect(output).toContain("postgresql://[REDACTED]@db.example/promptcut?ssl=true");
    expect(output).toContain("redis://[REDACTED]@redis.example:6379");
    expect(output).toContain("https://r2.example/object?signature=[REDACTED]");
    expect(output).not.toContain("user:pass");
    expect(output).not.toContain("X-Amz-Signature");
  });

  it("redacts authorization, cookies and nested json secrets", () => {
    const redacted = redactValue({
      headers: "Authorization: Bearer supersecrettoken123456 Cookie: session=abc123",
      nested: { apiKey: "sk-testsecret123456789", message: "OPENAI_API_KEY=sk-testsecret123456789" },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("supersecrettoken123456");
    expect(serialized).not.toContain("session=abc123");
    expect(serialized).not.toContain("sk-testsecret123456789");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts ffmpeg and codex stderr previews before truncating", () => {
    const secret = "https://r2.example/video.mp4?Signature=rawsignature CODEX_SESSION_TOKEN=codexsecret123456789";
    const preview = redactAndTruncate(`${secret} ${"x".repeat(5000)}`, 256);
    expect(preview.length).toBe(256);
    expect(containsUnredactedSecret(preview, ["rawsignature", "codexsecret123456789"])).toBe(false);
  });
});
