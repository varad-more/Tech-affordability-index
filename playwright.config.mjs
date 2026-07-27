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

  // The deployed artifact, not the development server. `dist/` is what GitHub
  // Pages publishes, so it is what the suite has to exercise: a run against
  // `flask run` would pass while the frozen output was missing a file, resolving
  // a path wrongly or serving the wrong 404 — the entire class of bug that
  // exists only because there is a build step.
  //
  // The server freezes before it serves, so the suite can never grade a stale
  // build.
  webServer: {
    // The local venv when there is one, otherwise whatever python is on PATH —
    // which is what CI provides. Hardcoding .venv/bin/python meant the suite
    // could only ever run on a machine that had one.
    // No --origin override: the suite grades the production artefact, canonical
    // tags and CNAME included. Those name the real domain while the server sits
    // on localhost, which is exactly the arrangement that ships — and the only
    // one in which asserting them means anything.
    command: `${process.env.FLASK_PYTHON ?? '.venv/bin/python'} scripts/serve_dist.py --port ${PORT}`,
    url: `http://localhost:${PORT}/bundle/meta.json`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
