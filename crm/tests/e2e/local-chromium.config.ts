import base from '../../playwright.config';
import { defineConfig } from '@playwright/test';

/**
 * LOCAL ONLY: the cloud container preinstalls Chromium revision 1194 while
 * @playwright/test 1.63 expects 1243, and browsers must not be downloaded
 * here. This reuses playwright.config.ts unchanged and only points Chromium
 * at the preinstalled binary (PLAYWRIGHT_CHROMIUM_PATH or /opt/pw-browsers/chromium).
 * CI keeps using playwright.config.ts with its own installed browsers.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: '../../test-results',
  webServer: { ...(base.webServer as object), cwd: new URL('../..', import.meta.url).pathname } as typeof base.webServer,
  use: { ...base.use, launchOptions: { executablePath } },
  projects: (base.projects ?? []).map((p) => ({
    ...p,
    use: { ...p.use, launchOptions: { executablePath } },
  })),
});
