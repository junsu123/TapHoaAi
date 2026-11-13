import { defineConfig } from "@playwright/test";

const PORT = process.env.CHIBI_PORT ?? "8686";

// WebGL in headless Chrome runs on SwiftShader (CPU). FPS numbers from CI are therefore
// NOT the performance target — benchmark on the real streaming PC (SPEC H1, NFR-02).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-report.json" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 540, height: 960 },
    launchOptions: {
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bash ../scripts/e2e_server.sh",
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
