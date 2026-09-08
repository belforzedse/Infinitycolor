import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/storefront', testMatch: 'defects2.spec.ts',
  outputDir: 'test-results/defects2', workers: 2, timeout: 60000,
  reporter: [['list'], ['json', { outputFile: 'test-results/defects2-results.json' }]],
  use: { serviceWorkers: 'block', baseURL: process.env.E2E_BASE_URL || 'http://localhost:2888', locale: 'fa-IR', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    ...[375,390,768,1024,1440].map(width => ({ name: `chromium-${width}`, use: { browserName: 'chromium' as const, viewport: { width, height: 900 }, hasTouch: width < 1024 } })),
    { name: 'webkit-390', use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
});
