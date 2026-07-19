import { defineConfig } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    env: { SRP_INJECTOR: 'fake' },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          // Auto-approve screen capture so the host flow runs unattended.
          args: [
            '--auto-select-desktop-capture-source=Entire screen',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
  ],
});
