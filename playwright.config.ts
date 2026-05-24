import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry"
  },
  webServer: {
    command: "rm -rf .next .promptcut-e2e-runtime && npm run prisma:generate && FFMPEG_BIN=./tests/fixtures/fake-ffmpeg.mjs FFPROBE_BIN=./tests/fixtures/fake-ffprobe.mjs PROMPTCUT_RUNTIME_ROOT=.promptcut-e2e-runtime OBSERVABILITY_TOKEN=ops-secret npm run build && FFMPEG_BIN=./tests/fixtures/fake-ffmpeg.mjs FFPROBE_BIN=./tests/fixtures/fake-ffprobe.mjs PROMPTCUT_RUNTIME_ROOT=.promptcut-e2e-runtime OBSERVABILITY_TOKEN=ops-secret npm run start -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 120000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    }
  ]
});
