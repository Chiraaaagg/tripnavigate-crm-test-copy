import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * Frozen-forms picture check (UX redesign, build plan 4.3).
 *
 * Compares the approved forms (Book now, Purchase, Flight and Visa Work tabs
 * and their dialogs) with pictures taken from the untouched forms on main.
 * The pictures are kept outside Git, in the folder named by
 * FROZEN_BASELINE_DIR. In CI (job "frozen-forms-visual" in
 * .github/workflows/ci.yml) every pull request records that folder from its
 * base commit with this config and the pull request's own test file, then
 * compares the pull request against it with zero tolerance:
 *
 *   FROZEN_BASELINE_DIR=$RUNNER_TEMP/frozen-forms-baseline \
 *   npx playwright test --config=playwright.visual.config.ts --update-snapshots=all   # on main's code
 *   FROZEN_BASELINE_DIR=$RUNNER_TEMP/frozen-forms-baseline \
 *   npx playwright test --config=playwright.visual.config.ts --update-snapshots=none  # on the pull request
 *
 * {-snapshotSuffix} keeps the platform in each picture name, so a record and
 * a compare in the same run always use the same names, and pictures from
 * another operating system are never compared by mistake.
 */
const dir = process.env.FROZEN_BASELINE_DIR;
if (!dir) {
  throw new Error('Set FROZEN_BASELINE_DIR to the folder that holds the frozen-form baseline pictures.');
}

export default defineConfig({
  ...base,
  testIgnore: [],
  snapshotPathTemplate: `${dir}/{arg}{-projectName}{-snapshotSuffix}{ext}`,
  projects: [
    {
      // Named "e2e" so the picture names match the baseline set.
      name: 'e2e',
      testMatch: /frozen-forms-visual\.e2e\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
