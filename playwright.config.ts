import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(localChrome) ? localChrome : undefined);
const builtApp = process.env.QA_BUILT_APP === '1';

export default defineConfig({
  testDir: './tests/e2e',
  // Cross-engine smoke requires explicitly selected installed/managed browser prerequisites.
  testIgnore: '**/crossbrowser.spec.ts',
  timeout: 90_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/qa-results.json' }]],
  use: {
    baseURL: process.env.QA_PREVIEW_BASE_URL || 'http://127.0.0.1:4173',
    viewport: { width: 430, height: 887 },
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath },
  },
  webServer: {
    command: builtApp ? 'npm run preview -- --port 4173 --strictPort' : 'npm run dev -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI && !builtApp,
    timeout: 30_000,
  },
});
