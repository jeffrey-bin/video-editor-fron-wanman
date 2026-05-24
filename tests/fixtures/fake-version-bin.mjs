#!/usr/bin/env node
if (process.argv.includes("-version") || process.argv.includes("--version")) {
  console.log("fake binary 1.0.0");
  process.exit(0);
}
console.error("unsupported fake binary command");
process.exit(2);
