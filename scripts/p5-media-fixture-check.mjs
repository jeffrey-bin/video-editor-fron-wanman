#!/usr/bin/env node
/* eslint-env node */
/* global console, process */
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeAudio, analyzeVideo, audioStream, fileSize, ffprobeJson, loadManifest, mediaDurationMs, repoRoot, videoStream } from "./p5-media-lib.mjs";

const main = async () => {
  const manifest = await loadManifest();
  const ids = new Set();
  const failures = [];
  for (const fixture of manifest.fixtures ?? []) {
    try {
      if (ids.has(fixture.id)) throw new Error(`duplicate id ${fixture.id}`);
      ids.add(fixture.id);
      if (!fixture.path.startsWith("tests/fixtures/media/") || fixture.path.includes("..")) throw new Error("path outside tests/fixtures/media");
      await access(resolve(repoRoot, fixture.path));
      const size = await fileSize(fixture.path);
      if (size <= (fixture.kind === "video" ? 32768 : 8192)) throw new Error(`file too small: ${size}`);
      const probe = await ffprobeJson(fixture.path);
      const durationDelta = Math.abs(mediaDurationMs(probe) - fixture.duration_ms);
      if (durationDelta > 100) throw new Error(`duration mismatch ${durationDelta}ms`);
      if (fixture.kind === "audio") {
        if (!audioStream(probe)) throw new Error("missing audio stream");
        const metrics = await analyzeAudio(fixture.path);
        if (metrics.rmsDbfs <= -80) throw new Error(`silent audio ${metrics.rmsDbfs}`);
      } else {
        if (!videoStream(probe)) throw new Error("missing video stream");
        if (!audioStream(probe)) throw new Error("missing audio stream");
        const metrics = await analyzeVideo(fixture.path);
        const minVariance = Math.min(...metrics.sampledFrames.map((frame) => frame.variance));
        if (minVariance <= 8) throw new Error(`placeholder-like video variance ${minVariance}`);
      }
    } catch (error) {
      failures.push({ id: fixture.id, error: error.message });
    }
  }
  if ((manifest.fixtures ?? []).length < 10) failures.push({ id: "manifest", error: "requires at least 10 fixtures" });
  if (failures.length > 0) {
    console.error(JSON.stringify({ status: "failed", failures }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "passed", fixtures: manifest.fixtures.length }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
