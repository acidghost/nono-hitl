import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Baselines are a local review aid and stay out of git.
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "e2e", testIgnore: "screenshots.spec.ts" },
    { name: "light", testMatch: "screenshots.spec.ts", use: { colorScheme: "light" } },
    { name: "dark", testMatch: "screenshots.spec.ts", use: { colorScheme: "dark" } },
  ],
});
