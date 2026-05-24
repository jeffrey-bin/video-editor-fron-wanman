import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { FfmpegCommand } from "@/server/ffmpeg/command-builder";

export type ExportExecutionResult = {
  outputPath: string;
  sizeBytes: number;
  mode: "ffmpeg";
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

const runProcess = async (bin: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdoutPromise = readLimited(child.stdout);
  const stderrPromise = readLimited(child.stderr);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(typeof value === "number" ? value : null));
  });
  return { code, stdout: await stdoutPromise, stderr: await stderrPromise };
};

const assertMp4Output = async (outputPath: string) => {
  const file = await stat(outputPath);
  if (!file.isFile() || file.size <= 0) throw new Error("导出文件不存在或为空");
  const handle = await open(outputPath, "r");
  try {
    const buffer = Buffer.alloc(12);
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(4, 8).toString("utf8") !== "ftyp") throw new Error("导出文件不是可验证的 MP4 容器");
  } finally {
    await handle.close();
  }
  const contents = await readFile(outputPath);
  if (contents.includes("promptcut-local-dev-mp4")) throw new Error("导出文件是伪 MP4，拒绝标记为成功");
  return file;
};

const assertFfprobeOutput = async (command: FfmpegCommand) => {
  const result = await runProcess(command.ffprobeBin, ["-v", "error", "-show_format", "-show_streams", "-of", "json", command.outputPath]);
  if (result.code !== 0) throw new Error(`ffprobe 校验失败: ${result.stderr || "无法解析导出文件"}`);
  const payload = JSON.parse(result.stdout || "{}") as { streams?: unknown[]; format?: { format_name?: string } };
  if (!Array.isArray(payload.streams) || payload.streams.length === 0) throw new Error("ffprobe 校验失败: 导出文件没有可解码媒体流");
  if (!payload.format?.format_name?.includes("mp4")) throw new Error("ffprobe 校验失败: 导出文件不是 MP4 格式");
};

export const executeExport = async (command: FfmpegCommand): Promise<ExportExecutionResult> => {
  await mkdir(dirname(command.outputPath), { recursive: true });
  const result = await runProcess(command.bin, command.args);
  if (result.code !== 0) throw new Error(`ffmpeg 导出失败: ${result.stderr || `exit ${result.code ?? "unknown"}`}`);
  const file = await assertMp4Output(command.outputPath);
  await assertFfprobeOutput(command);
  return { outputPath: command.outputPath, sizeBytes: file.size, mode: "ffmpeg", stderr: result.stderr.slice(0, 8192) };
};
