import { defineConfig, devices } from '@playwright/test';

// All specs hit ONE shared backend (a single test-server boot with a single
// leads.json), so run serially to keep mutations deterministic + isolated.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      // Real backend with WhatsApp faked (test-server.mjs).
      command: 'node test-server.mjs',
      url: 'http://localhost:10001/api/status',
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Web (Next.js). Assumes web is already built — `test:full` builds first;
      // in CI the build runs in a prior step.
      command: 'npm --prefix ../web run start',
      url: 'http://localhost:3000',
      timeout: 120000,
      reuseExistingServer: !process.env.CI,
      env: {
        WA_SERVER_URL: 'http://localhost:10001',
        AUTH_USER: 'testadmin',
        AUTH_PASSWORD: 'testpass',
        AUTH_SECRET: 'test-secret-please-change-0123456789',
        PORT: '3000',
      },
    },
  ],
});
