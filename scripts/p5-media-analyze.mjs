#!/usr/bin/env node
/* eslint-env node */
/* global console, process */
import { analyzeAudio, analyzeVideo, loadManifest, writeJson } from "./p5-media-lib.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const main = async () => {
  const manifest = await loadManifest(arg("--manifest", undefined));
  const fixtures = [];
  for (const fixture of manifest.fixtures) {
    fixtures.push({
      id: fixture.id,
      kind: fixture.kind,
      path: fixture.path,
      metrics: fixture.kind === "audio"
        ? await analyzeAudio(fixture.path, { segments: { first_half: { startMs: 0, endMs: fixture.duration_ms / 2 }, second_half: { startMs: fixture.duration_ms / 2, endMs: fixture.duration_ms } } })
        : await analyzeVideo(fixture.path),
    });
  }
  const payload = { schema: "promptcut.p5-media-analysis", version: 1, fixtures };
  if (arg("--report", "")) await writeJson(arg("--report", ""), payload);
  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
