/* eslint-env node */
/* global process, URL, Buffer */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);

export const repoRoot = resolve(new URL("..", import.meta.url).pathname);
export const manifestPath = "tests/fixtures/media/manifests/p5-real-media-fixtures.json";
export const ffmpegBin = () => process.env.FFMPEG_BIN ?? require("@ffmpeg-installer/ffmpeg").path;
export const ffprobeBin = () => process.env.FFPROBE_BIN ?? require("@ffprobe-installer/ffprobe").path;

export const run = (bin, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], ...options });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolvePromise({ stdout: out, stderr: err });
      else reject(new Error(`${bin} exited ${code}: ${err.slice(-4000)}`));
    });
  });

export const ensureDir = async (path) => mkdir(dirname(resolve(repoRoot, path)), { recursive: true });

export const sha256 = async (path) => createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex");

export const fileSize = async (path) => (await stat(resolve(repoRoot, path))).size;

export const ffprobeJson = async (path) => {
  const { stdout } = await run(ffprobeBin(), ["-v", "error", "-show_format", "-show_streams", "-of", "json", resolve(repoRoot, path)]);
  return JSON.parse(stdout.toString("utf8"));
};

export const mediaDurationMs = (probe) => Math.round(Number(probe.format?.duration ?? 0) * 1000);
export const videoStream = (probe) => probe.streams?.find((stream) => stream.codec_type === "video");
export const audioStream = (probe) => probe.streams?.find((stream) => stream.codec_type === "audio");

export const readPcmMono = async (path, sampleRate = 48000) => {
  const { stdout } = await run(ffmpegBin(), [
    "-v", "error",
    "-i", resolve(repoRoot, path),
    "-vn",
    "-ac", "1",
    "-ar", String(sampleRate),
    "-f", "s16le",
    "pipe:1",
  ]);
  const samples = new Float32Array(stdout.length / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = stdout.readInt16LE(index * 2) / 32768;
  return { samples, sampleRate };
};

const measureLoudness = async (path) => {
  try {
    const { stderr } = await run(ffmpegBin(), [
      "-hide_banner",
      "-nostats",
      "-i", resolve(repoRoot, path),
      "-af", "loudnorm=I=-16:TP=-1:LRA=11:print_format=json",
      "-f", "null",
      "-",
    ]);
    const json = stderr.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return {};
    const measured = JSON.parse(json);
    return {
      integratedLufs: Number(measured.input_i),
      loudnormTruePeakDbfs: Number(measured.input_tp),
    };
  } catch {
    return {};
  }
};

const dbfs = (value) => (!Number.isFinite(value) || value <= 0 ? -120 : 20 * Math.log10(Math.min(1, value)));
export const rmsDbfs = (samples) => {
  if (samples.length === 0) return -120;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return dbfs(Math.sqrt(sum / samples.length));
};
export const peakDbfs = (samples) => {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return dbfs(peak);
};
export const segment = (samples, sampleRate, startMs, endMs) =>
  samples.subarray(Math.max(0, Math.floor(startMs * sampleRate / 1000)), Math.min(samples.length, Math.ceil(endMs * sampleRate / 1000)));

export const analyzeAudio = async (path, options = {}) => {
  const probe = await ffprobeJson(path);
  const { samples, sampleRate } = await readPcmMono(path);
  const loudness = await measureLoudness(path);
  const segmentRms = {};
  for (const [name, range] of Object.entries(options.segments ?? {})) segmentRms[name] = rmsDbfs(segment(samples, sampleRate, range.startMs, range.endMs));
  const metrics = {
    durationMs: mediaDurationMs(probe),
    integratedLufs: Number.isFinite(loudness.integratedLufs) ? loudness.integratedLufs : rmsDbfs(samples),
    truePeakDbfs: peakDbfs(samples),
    rmsDbfs: rmsDbfs(samples),
    peakDbfs: peakDbfs(samples),
    clipSampleRatio: samples.length ? samples.filter((sample) => Math.abs(sample) >= 0.999).length / samples.length : 0,
    silenceRanges: Object.entries(segmentRms).filter(([, value]) => value <= -60).map(([name, value]) => ({ startMs: options.segments[name].startMs, endMs: options.segments[name].endMs, rmsDbfs: value })),
    segmentRms,
    noiseFloorDbfs: Object.values(segmentRms).length ? Math.min(...Object.values(segmentRms)) : undefined,
  };
  if (options.fade) metrics.fadeTrend = fadeTrend(samples, sampleRate, options.fade);
  return metrics;
};

export const fadeTrend = (samples, sampleRate, fade) => {
  const values = [];
  const windowMs = fade.windowMs ?? 200;
  for (let startMs = fade.startMs; startMs < fade.endMs; startMs += windowMs) {
    values.push(rmsDbfs(segment(samples, sampleRate, startMs, Math.min(fade.endMs, startMs + windowMs))));
  }
  let monotonicWindows = 0;
  let reverseWindows = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    const ok = fade.direction === "in" ? delta >= -0.75 : delta <= 0.75;
    if (ok) monotonicWindows += 1;
    else reverseWindows += 1;
  }
  return { direction: fade.direction, monotonicWindows, reverseWindows, windowMs, startMs: fade.startMs, endMs: fade.endMs, values };
};

const frameRate = (value) => {
  const [num, den] = String(value ?? "0/1").split("/").map(Number);
  return den ? num / den : 0;
};

const frameMetrics = (rgb, width, height, atPercent) => {
  const pixels = width * height;
  let sumY = 0;
  let sumY2 = 0;
  let sumSaturation = 0;
  let overexposed = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 3;
    const r = rgb[offset];
    const g = rgb[offset + 1];
    const b = rgb[offset + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    sumY += y;
    sumY2 += y * y;
    sumSaturation += max === 0 ? 0 : (max - min) / max;
    if (y >= 250) overexposed += 1;
  }
  const meanY = sumY / pixels;
  const variance = Math.max(0, sumY2 / pixels - meanY * meanY);
  return { atPercent, meanY, stddevY: Math.sqrt(variance), meanSaturation: sumSaturation / pixels, variance, overexposedRatio: overexposed / pixels };
};

export const analyzeVideo = async (path) => {
  const probe = await ffprobeJson(path);
  const stream = videoStream(probe);
  if (!stream) throw new Error(`No video stream in ${path}`);
  const durationMs = mediaDurationMs(probe);
  const width = Number(stream.width);
  const height = Number(stream.height);
  const sampledFrames = [];
  for (const atPercent of [10, 50, 90]) {
    const seconds = Math.max(0, (durationMs * atPercent / 100) / 1000);
    const { stdout } = await run(ffmpegBin(), [
      "-v", "error",
      "-ss", seconds.toFixed(3),
      "-i", resolve(repoRoot, path),
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "pipe:1",
    ]);
    if (stdout.length < width * height * 3) throw new Error(`Could not decode sampled frame at ${atPercent}%`);
    sampledFrames.push(frameMetrics(stdout, width, height, atPercent));
  }
  return { durationMs, width, height, frameRate: frameRate(stream.avg_frame_rate), sampledFrames };
};

export const writeJson = async (path, payload) => {
  await ensureDir(path);
  await writeFile(resolve(repoRoot, path), `${JSON.stringify(payload, null, 2)}\n`);
};

export const loadManifest = async (path = manifestPath) => JSON.parse(await readFile(resolve(repoRoot, path), "utf8"));
