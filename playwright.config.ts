import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:4200';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL, ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: baseURL.startsWith('http://localhost:4200')
    ? [
        {
          command: 'npm run server',
          url: 'http://localhost:3001/api/health',
          reuseExistingServer: !process.env['CI'],
        },
        {
          command: 'npm start -- --host 127.0.0.1',
          url: 'http://localhost:4200',
          reuseExistingServer: !process.env['CI'],
        },
      ]
    : undefined,
});
