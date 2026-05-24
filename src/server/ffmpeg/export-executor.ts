import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FfmpegCommand } from "@/server/ffmpeg/command-builder";

export type ExportExecutionResult = {
  outputPath: string;
  sizeBytes: number;
  mode: "ffmpeg" | "local-dev-manifest";
  stderr?: string;
};

const readLimited = (stream: NodeJS.ReadableStream, limit = 8192): Promise<string> =>
  new Promise((resolve) => {
    let output = "";
    stream.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-limit);
    });
    stream.on("end", () => resolve(output));
  });

const runFfmpeg = async (command: FfmpegCommand): Promise<{ code: number | null; stderr: string }> => {
  const child = spawn(command.bin, command.args, { stdio: ["ignore", "ignore", "pipe"] });
  const stderrPromise = readLimited(child.stderr);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(typeof value === "number" ? value : null));
  });
  return { code, stderr: await stderrPromise };
};

const writeLocalDevManifest = async (command: FfmpegCommand, reason: string) => {
  await writeFile(
    command.outputPath,
    JSON.stringify(
      {
        format: "promptcut-local-dev-export",
        reason,
        command: { bin: command.bin, args: command.args },
        renderPlan: command.renderPlan,
      },
      null,
      2,
    ),
  );
};

export const executeExport = async (command: FfmpegCommand): Promise<ExportExecutionResult> => {
  await mkdir(dirname(command.outputPath), { recursive: true });
  let mode: ExportExecutionResult["mode"] = "ffmpeg";
  let stderr = "";
  try {
    const result = await runFfmpeg(command);
    stderr = result.stderr;
    if (result.code !== 0) {
      mode = "local-dev-manifest";
      await writeLocalDevManifest(command, `ffmpeg exited with ${result.code ?? "no-code"}`);
    }
  } catch (error) {
    mode = "local-dev-manifest";
    stderr = error instanceof Error ? error.message : "ffmpeg unavailable";
    await writeLocalDevManifest(command, "ffmpeg unavailable in local development environment");
  }
  const file = await stat(command.outputPath);
  if (!file.isFile() || file.size <= 0) throw new Error("导出文件不存在或为空");
  return { outputPath: command.outputPath, sizeBytes: file.size, mode, stderr: stderr.slice(0, 8192) };
};
