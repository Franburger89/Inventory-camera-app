import { defineConfig, devices } from '@playwright/test';

const iPhone = devices['iPhone 13'];

export default defineConfig({
  testDir: 'test',
  testMatch: '**/*.spec.js',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    viewport: iPhone.viewport,
    deviceScaleFactor: iPhone.deviceScaleFactor,
    isMobile: iPhone.isMobile,
    hasTouch: iPhone.hasTouch,
    userAgent: iPhone.userAgent,
    permissions: ['camera'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
  webServer: [
    {
      command: 'rm -rf .tmp/e2e-open && node src/server.js',
      port: 4173,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PORT: '4173',
        STAFF_PIN: '',
        ADMIN_TOKEN: 'test-admin-token',
        DATA_DIR: '.tmp/e2e-open',
      },
    },
    {
      command: 'rm -rf .tmp/e2e-pin && node src/server.js',
      port: 4174,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PORT: '4174',
        STAFF_PIN: '2468',
        ADMIN_TOKEN: 'test-admin-token',
        DATA_DIR: '.tmp/e2e-pin',
      },
    },
  ],
});
