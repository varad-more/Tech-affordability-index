import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // A stray .only must never silently narrow the suite in CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // In CI also emit the HTML report, so a failed run uploads something you can
  // actually open — traces, screenshots and all — instead of an empty artifact.
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : 'list',

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Serves the real published files — the same flat directory GitHub Pages gets.
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
