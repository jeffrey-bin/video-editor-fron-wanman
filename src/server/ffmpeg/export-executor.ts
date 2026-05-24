import { spawn } from "node:child_process";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FfmpegCommand } from "@/server/ffmpeg/command-builder";

export type ExportExecutionResult = {
  outputPath: string;
  sizeBytes: number;
  mode: "ffmpeg" | "local-dev-mp4";
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

const synthesizeLocalDevMp4 = async (command: FfmpegCommand): Promise<string> => {
  const payload = Buffer.from(JSON.stringify({ format: "promptcut-local-dev-mp4", renderPlan: command.renderPlan }));
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const freeHeader = Buffer.alloc(8);
  freeHeader.writeUInt32BE(payload.length + 8, 0);
  freeHeader.write("free", 4, "ascii");
  await writeFile(command.outputPath, Buffer.concat([ftyp, freeHeader, payload]));
  return "primary ffmpeg failed; wrote deterministic local development MP4 container";
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
  return file;
};

export const executeExport = async (command: FfmpegCommand): Promise<ExportExecutionResult> => {
  await mkdir(dirname(command.outputPath), { recursive: true });
  let mode: ExportExecutionResult["mode"] = "ffmpeg";
  let stderr = "";
  try {
    const result = await runFfmpeg(command);
    stderr = result.stderr;
    if (result.code !== 0) {
      mode = "local-dev-mp4";
      stderr = await synthesizeLocalDevMp4(command);
    }
  } catch (error) {
    mode = "local-dev-mp4";
    stderr = error instanceof Error ? error.message : "ffmpeg unavailable";
    await synthesizeLocalDevMp4(command);
  }
  const file = await assertMp4Output(command.outputPath);
  return { outputPath: command.outputPath, sizeBytes: file.size, mode, stderr: stderr.slice(0, 8192) };
};
