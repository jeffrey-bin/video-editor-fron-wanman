import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeExport } from "@/server/ffmpeg/export-executor";
import type { FfmpegCommand } from "@/server/ffmpeg/command-builder";

let dir = "";

const command = (args: string[], outputPath: string): FfmpegCommand => ({
  bin: process.execPath as "ffmpeg",
  args,
  outputPath,
  requiresReencode: true,
  renderPlan: {
    durationMs: 1000,
    segments: [{ clipId: "clip", trackId: "video", assetId: "asset", inputPath: "/tmp/input.mp4", timelineStartMs: 0, timelineEndMs: 1000, sourceStartMs: 0, sourceEndMs: 1000 }],
    subtitles: [],
    hasVideoFilters: false,
    hasAudioFilters: false,
  },
});

describe("export executor", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promptcut-export-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("marks ffmpeg mode only after the output file is non-empty", async () => {
    const output = join(dir, "ok.mp4");
    const result = await executeExport(command(["-e", `require('fs').writeFileSync(process.argv[1], 'video')`, output], output));
    expect(result.mode).toBe("ffmpeg");
    expect(result.sizeBytes).toBe((await stat(output)).size);
    expect(await readFile(output, "utf8")).toBe("video");
  });

  it("writes a non-empty local development manifest when ffmpeg fails", async () => {
    const output = join(dir, "fallback.mp4");
    const result = await executeExport(command(["-e", "console.error('bad input'); process.exit(2)"], output));
    expect(result.mode).toBe("local-dev-manifest");
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(await readFile(output, "utf8")).toContain("promptcut-local-dev-export");
  });
});
