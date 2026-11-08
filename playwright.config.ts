import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser",
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  use: {
    baseURL: "http://127.0.0.1:4294",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "MIRAGE_DATA=.data/browser API_PORT=4294 node dist/server/index.js",
    url: "http://127.0.0.1:4294",
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: ".data/browser-report" }],
  ],
});
