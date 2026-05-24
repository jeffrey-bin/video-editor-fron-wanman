import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeExport } from "@/server/ffmpeg/export-executor";
import type { FfmpegCommand } from "@/server/ffmpeg/command-builder";

let dir = "";
let ffmpegBin = "";
let ffprobeBin = "";
let failingFfprobeBin = "";

const command = (args: string[], outputPath: string): FfmpegCommand => ({
  bin: ffmpegBin,
  ffprobeBin,
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
    ffmpegBin = join(dir, "fake-ffmpeg.mjs");
    ffprobeBin = join(dir, "fake-ffprobe.mjs");
    failingFfprobeBin = join(dir, "failing-ffprobe.mjs");
    await writeFile(ffmpegBin, `#!/usr/bin/env node
import { copyFile } from "node:fs/promises";
const input = process.argv[2];
const output = process.argv.at(-1);
if (!input || !output) process.exit(2);
await copyFile(input, output);
`);
    await writeFile(ffprobeBin, `#!/usr/bin/env node
console.log(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264" }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" } }));
`);
    await writeFile(failingFfprobeBin, `#!/usr/bin/env node
console.error("invalid data found when processing input");
process.exit(1);
`);
    await Promise.all([chmod(ffmpegBin, 0o755), chmod(ffprobeBin, 0o755), chmod(failingFfprobeBin, 0o755)]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("marks ffmpeg mode only after a real MP4 fixture is non-empty and ffprobe-decodable", async () => {
    const output = join(dir, "ok.mp4");
    const fixture = join(process.cwd(), "tests/fixtures/minimal-real.mp4");
    const result = await executeExport(command([fixture, output], output));
    expect(result.mode).toBe("ffmpeg");
    expect(result.sizeBytes).toBe((await stat(output)).size);
    const exported = await readFile(output);
    expect(exported.subarray(4, 8).toString("utf8")).toBe("ftyp");
    expect(exported.includes("promptcut-local-dev-mp4")).toBe(false);
  });

  it("fails instead of synthesizing a successful local-dev MP4 when ffmpeg fails", async () => {
    const output = join(dir, "failed.mp4");
    await expect(executeExport({ ...command(["missing-input.mp4", output], output), bin: process.execPath, args: ["-e", "console.error('bad input'); process.exit(2)"] })).rejects.toThrow("ffmpeg 导出失败");
  });

  it("fails when ffprobe cannot decode the exported MP4", async () => {
    const output = join(dir, "probe-failed.mp4");
    const fixture = join(process.cwd(), "tests/fixtures/minimal-real.mp4");
    await expect(executeExport({ ...command([fixture, output], output), ffprobeBin: failingFfprobeBin })).rejects.toThrow("ffprobe 校验失败");
  });
});
