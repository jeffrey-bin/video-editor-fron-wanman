#!/usr/bin/env node
import { copyFile } from "node:fs/promises";

const inputIndex = process.argv.findIndex((arg) => arg === "-i");
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : process.argv[2];
const outputPath = process.argv.at(-1);

if (!inputPath || !outputPath) {
  console.error("fake ffmpeg missing input or output");
  process.exit(2);
}

await copyFile(inputPath, outputPath);
