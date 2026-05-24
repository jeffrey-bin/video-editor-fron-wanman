#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const inputPath = process.argv.at(-1);
if (!inputPath) {
  console.error("fake ffprobe missing input");
  process.exit(2);
}

const bytes = await readFile(inputPath);
if (bytes.subarray(4, 8).toString("utf8") !== "ftyp" || bytes.includes("promptcut-local-dev-mp4")) {
  console.error("invalid mp4 fixture");
  process.exit(1);
}

console.log(JSON.stringify({
  streams: [{ codec_type: "video", codec_name: "h264" }],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
}));
