#!/usr/bin/env node
/* eslint-env node */
/* global console, process */
import { copyFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(repoRoot, "test-results/p5-runner-dist");
const tscBin = resolve(repoRoot, "node_modules/.bin/tsc");

const run = (bin, args) => {
  const result = spawnSync(bin, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

await rm(distRoot, { recursive: true, force: true });
await mkdir(resolve(distRoot, "scripts"), { recursive: true });
run(tscBin, ["-p", "scripts/tsconfig.p5-runner.json"]);
await copyFile(resolve(repoRoot, "scripts/p5-media-lib.mjs"), resolve(distRoot, "scripts/p5-media-lib.mjs"));
await writeFile(resolve(distRoot, "package.json"), "{\"type\":\"module\"}\n");
await mkdir(resolve(distRoot, "node_modules/@"), { recursive: true });
await symlink(resolve(distRoot, "src/server"), resolve(distRoot, "node_modules/@/server"), "dir");
await symlink(resolve(distRoot, "src/types"), resolve(distRoot, "node_modules/@/types"), "dir");
await writeFile(resolve(distRoot, "node_modules/@/server/package.json"), "{\"type\":\"module\",\"exports\":{\"./*\":\"./*.js\"}}\n");
await writeFile(resolve(distRoot, "node_modules/@/types/package.json"), "{\"type\":\"module\",\"exports\":{\"./*\":\"./*.js\"}}\n");

run(process.execPath, [resolve(distRoot, "scripts/p5-real-media-runner.js"), ...process.argv.slice(2)]);
