import { expect, test, type Locator, type Page } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { waitForHydration } from './hydration';

/**
 * UX redesign R0 (build plan 4.3, "Baseline screenshots"): the comparison set
 * for the approved forms, which are frozen for the whole redesign. Every
 * later slice runs this file unchanged; any pixel difference on a frozen form
 * fails it.
 *
 * Covered, from the synthetic preview gallery states (no database):
 *   - Book now (src/views/booking-form/**): every scenario at all three steps,
 *     and its drawers and dialogs opened from those states;
 *   - Purchase task Work tab (src/views/purchase/work-tab.tsx, work-forms.tsx,
 *     email-drawer.tsx, go-ahead.tsx) and its drawers;
 *   - Flight task Work tab (src/views/flight/**) with its popup states and the
 *     "Mark flight done" dialog;
 *   - Visa task Work tab (src/views/visa/**) with its popup states.
 *
 * Each picture is taken at 1280 px and 390 px wide.
 *
 * Stability: reduced motion, animations disabled and the caret hidden for the
 * picture, fonts loaded before the picture (Inter comes from next/font/local,
 * so it never depends on the network), hydration finished, and the only
 * clock value on these forms masked: a date box that holds today's date (the
 * Visa popups default "paid on" and "applied on" to today in India; every
 * other date comes from the fixed preview data). A search of the frozen
 * views and the code they import found no other use of the current time
 * that reaches the screen.
 *
 * Baselines are never stored in Git. On every pull request the CI job
 * "frozen-forms-visual" (.github/workflows/ci.yml) records them from the
 * pull request's base (main) with this same file and config, into a
 * temporary folder named by FROZEN_BASELINE_DIR, and then compares the pull
 * request against them on the same runner, so both sides always come from
 * the same operating system, browser and fonts. Picture names keep the
 * platform suffix ("-linux", "-darwin"; see playwright.visual.config.ts), so
 * pictures from different systems are never compared with each other.
 * To record by hand, only on purpose and only from the untouched forms:
 *   FROZEN_BASELINE_DIR=<folder> E2E_PORT=3413 npx playwright test --config=playwright.visual.config.ts --update-snapshots=all
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);
test.use({ reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-IN', timezoneId: 'Asia/Kolkata', deviceScaleFactor: 1 });
test.describe.configure({ mode: 'parallel' });

const VIEWPORTS = [
  { tag: '1280', width: 1280, height: 860 },
  { tag: '390', width: 390, height: 844 },
] as const;

/** Book now scenarios (BOOKFORM_SCENARIOS in src/app/preview/[state]/bookform-states.tsx, plus flight-only). */
const BOOK_NOW_SCENARIOS = [
  'v2', 'v2-nocopy', 'v2-quote', 'v2-empty', 'empty', 'owner', 'gaps', 'refused', 'no-price', 'verified', 'legacy',
  'read-only', 'auto', 'vn-deal', 'vn-gaps', 'vn-nodeal', 'vn-billto', 'vn-billto-picked', 'vn-billto-pickfail',
  'vn-billto-searchfail', 'flight-only',
] as const;
const BOOK_NOW_STATES = BOOK_NOW_SCENARIOS.flatMap((s) => (['travellers', 'stay', 'finish'] as const).map((step) => `bookform-${s}--${step}`));

const PURCHASE_STATES = [
  'pb-task-work-no-rates', 'pb-task-work-final-rate', 'pb-task-work-waiting-go-ahead', 'pb-task-work-go-ahead-given',
  'pb-task-work-go-ahead-returned', 'pb-task-work-over-budget', 'pb-task-work-over-budget-manager', 'pb-task-work-transfer',
  'pb-task-work-cancelled', 'pb-task-work-confirmed', 'pb-task-work-confirmed-pay',
];

const FLIGHT_STATES = [
  'flight-ws-not-taken', 'flight-ws-claim-conflict', 'flight-ws-work', 'flight-ws-screenshot', 'flight-ws-pending-package',
  'flight-ws-change-refused', 'flight-ws-flight-only', 'flight-ws-booking-changed', 'flight-ws-popup-within',
  'flight-ws-popup-over', 'flight-ws-popup-approved', 'flight-ws-popup-refused', 'flight-ws-tickets', 'flight-ws-legacy-paid',
  'flight-ws-flight-only-margins', 'flight-ws-flight-only-purchase-holder', 'flight-ws-flight-only-no-margins',
  'flight-ws-payment-over', 'flight-ws-payment-over-flight-only', 'flight-ws-payment-returned', 'flight-ws-cancel-request',
  'flight-ws-cancel-refused', 'flight-ws-cancel-former-requester', 'flight-ws-cancel-not-yours', 'flight-ws-ready',
  'flight-ws-done', 'flight-ws-invoice-missing', 'flight-ws-invoices', 'flight-ws-suppliers', 'flight-ws-bank-refused',
  'flight-ws-manager',
];

const VISA_STATES = [
  'visa-task-not-taken-work', 'visa-work', 'visa-work-edit-row', 'visa-work-edit-row-refused', 'visa-work-edit-row-echo',
  'visa-work-edit-row-kind', 'visa-work-booking-changed', 'visa-popup-add-doc', 'visa-popup-add-doc-refused',
  'visa-popup-upload-doc', 'visa-popup-remove-doc', 'visa-popup-other-cost', 'visa-popup-apply', 'visa-popup-apply-club',
  'visa-popup-apply-refused', 'visa-popup-apply-kind', 'visa-work-selected', 'visa-work-applied', 'visa-popup-approve',
  'visa-popup-approve-refused', 'visa-popup-approve-evisa', 'visa-popup-reject', 'visa-popup-reject-evisa',
  'visa-popup-withdraw', 'visa-work-approved-evisa', 'visa-work-handover-pending', 'visa-popup-handover',
  'visa-popup-delivered', 'visa-popup-delivered-refused', 'visa-work-rejected', 'visa-popup-reapply',
  'visa-work-second-application', 'visa-work-withdrawn', 'visa-work-fee-returned', 'visa-popup-fix-fee',
  'visa-popup-fix-fee-refused', 'visa-popup-send-fee', 'visa-work-completed', 'visa-work-completed-draft-fee',
  'visa-work-completed-returned-fee', 'visa-popup-completed-send-fee', 'visa-passport-work', 'visa-popup-passport-handover',
  'visa-manager-work', 'visa-book-now-drawer',
];

/** Dialogs and drawers that open from a button in a gallery state. */
interface OpenedDialog {
  name: string;
  state: string;
  open: (page: Page) => Promise<Locator>;
}

const main = (page: Page) => page.locator('main');

async function openFrom(page: Page, button: Locator, dialogName: string | RegExp): Promise<Locator> {
  await button.click();
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  return dialog;
}

const DIALOGS: OpenedDialog[] = [
  // Book now
  { name: 'booknow-passenger-details', state: 'bookform-vn-deal--travellers',
    open: (p) => openFrom(p, main(p).getByRole('button', { name: 'Details for passenger 1' }), 'Passenger details') },
  { name: 'booknow-correct-trip-details', state: 'bookform-vn-deal--travellers',
    open: (p) => openFrom(p, main(p).locator('section#customer').getByRole('button', { name: 'Correct' }), 'Correct trip details in Bitrix') },
  { name: 'booknow-id-proof', state: 'bookform-vn-deal--travellers',
    open: (p) => openFrom(p, main(p).getByRole('button', { name: 'Attach ID proof for Sample Traveller A' }), /ID proof · Sample Traveller A/) },
  { name: 'booknow-add-hotel', state: 'bookform-vn-deal--stay',
    open: (p) => openFrom(p, main(p).getByRole('button', { name: 'Add hotel' }), 'Add hotel stay') },
  { name: 'booknow-add-flight', state: 'bookform-vn-deal--stay',
    open: (p) => openFrom(p, main(p).getByRole('button', { name: 'Add flight' }), 'Add flight') },
  { name: 'booknow-edit-flight', state: 'bookform-vn-deal--stay',
    open: (p) => openFrom(p, main(p).getByRole('button', { name: 'Edit flight 1' }), 'Edit flight') },
  { name: 'booknow-add-car', state: 'bookform-vn-deal--stay',
    open: (p) => openFrom(p, main(p).getByRole('button', { name: 'Add car' }), 'Add car') },
  { name: 'booknow-add-customer', state: 'bookform-vn-billto--finish',
    open: (p) => openFrom(p, main(p).locator('section#billTo').getByRole('button', { name: 'Add customer' }), 'Add customer') },
  // Purchase
  { name: 'purchase-ask-for-rates', state: 'pb-task-work-no-rates',
    open: (p) => openFrom(p, p.getByRole('button', { name: 'Ask for rates' }), 'Ask the supplier for rates') },
  { name: 'purchase-booking-request', state: 'pb-task-work-final-rate',
    open: (p) => openFrom(p, p.getByRole('button', { name: 'Send booking request' }), 'Send the booking request') },
  { name: 'purchase-advance-payment', state: 'pb-task-work-go-ahead-given',
    open: (p) => openFrom(p, p.getByRole('button', { name: 'Request advance payment' }), 'Request a supplier payment') },
  { name: 'purchase-balance-payment', state: 'pb-task-work-confirmed-pay',
    open: (p) => openFrom(p, p.getByRole('button', { name: 'Request payment' }), 'Request a supplier payment') },
  // Flight
  { name: 'flight-mark-done', state: 'flight-ws-ready',
    open: async (p) => {
      await main(p).getByRole('button', { name: 'Mark flight done' }).click();
      const dialog = p.getByRole('dialog');
      await expect(dialog).toBeVisible();
      return dialog;
    } },
];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await waitForHydration(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loading' || f.status === 'error').length)).toBe(0);
  // Drawers slide in: wait until no finite animation is still running.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

/** Gallery states that open a dialog on first load (after hydration): wait for it before the picture. */
const OPENS_A_DIALOG = /^visa-popup-/;

async function open(page: Page, state: string) {
  const response = await page.goto(`/preview/${state}`);
  expect(response?.status(), `${state} opens`).toBe(200);
  // includeHidden: a dialog open on first paint hides the page (and its h1) from assistive technology.
  await expect(page.getByRole('heading', { level: 1, includeHidden: true })).toBeAttached();
  if (OPENS_A_DIALOG.test(state)) await expect(page.getByRole('dialog')).toBeVisible();
  await settle(page);
}

/** Today in India, as the Visa popups compute it (src/views/visa/format.ts todayIst). */
const todayIst = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const clocks = (page: Page) => [page.locator(`input[type="date"][value="${todayIst()}"]`)];

const SHOT = { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0 } as const;

for (const vp of VIEWPORTS) {
  test.describe(`frozen forms at ${vp.tag} px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    const groups: Array<[string, string[]]> = [
      ['booknow', BOOK_NOW_STATES],
      ['purchase', PURCHASE_STATES],
      ['flight', FLIGHT_STATES],
      ['visa', VISA_STATES],
    ];
    for (const [group, states] of groups) {
      for (const state of states) {
        test(`${group} ${state} ${vp.tag}`, async ({ page }) => {
          await open(page, state);
          await expect(page).toHaveScreenshot(`${state}-${vp.tag}.png`, { ...SHOT, fullPage: true, mask: clocks(page) });
        });
      }
    }

    for (const d of DIALOGS) {
      test(`dialog ${d.name} ${vp.tag}`, async ({ page }) => {
        await open(page, d.state);
        await d.open(page);
        await settle(page);
        await expect(page).toHaveScreenshot(`dialog-${d.name}-${vp.tag}.png`, { ...SHOT, mask: clocks(page) });
      });
    }
  });
}
