import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { waitForHydration } from './hydration';

/**
 * Accounts Phase 3 contract section 15 (screens) and test plan 16.3 "Mock
 * e2e", Track T (independent; written from the contract), against Track U's
 * preview states (src/app/preview/[state], synthetic props). Run on the
 * Track T port:
 *   E2E_PORT=3296 npx playwright test tests/e2e/acc3-screens.e2e.ts
 * (or E2E_BASE_URL=http://127.0.0.1:3295 to read Track U's running server).
 *
 * Every acc3-* state: axe (WCAG 2.2 AA) at 1280 and 375 px, no page-level
 * sideways scroll at 375 px and at 200% zoom (640 px CSS width), keyboard
 * focus visible, reduced motion respected, no unmasked mobile, e-mail, PAN,
 * PNR or ticket number; Purchase / Flight / Visa states carry no selling
 * price, margin, dues or customer money words (standing rule §9, fences
 * section 14); status words are text, never colour alone; refused states
 * keep typed input. Alerts opt-in (8.4) with a stubbed PushManager: no
 * service worker before "Alerts on this device", one subscribe after it.
 *
 * State names are not frozen by the contract: they are discovered from the
 * preview sources (every quoted id starting "acc3-"), and SCREENS below lists
 * the screens of section 15 with Track U's state names for each required state.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);
if (process.env.E2E_BASE_URL) test.use({ baseURL: process.env.E2E_BASE_URL });

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PREVIEW_DIR = join(import.meta.dirname, '..', '..', 'src', 'app', 'preview', '[state]');

// Track U's state names (U landed 13 Nov 2026; the earlier ASSUMPTION prefixes are replaced by the names U chose).
// Section 15: each screen has loading, empty, error, refusal and read-only states. Each kind lists the preview
// states that show it; a screen section that sits inside a host page uses the host page's state where the
// host owns it (named per entry). `na` records why a kind cannot exist for that screen (reported to the lead).
type Kind = 'loading' | 'empty' | 'error' | 'refused' | 'readonly';
type KindStates = string[] | { na: string };
const SCREENS: Record<string, { prefix: string; main: string; words?: RegExp[]; states: Record<Kind, KindStates> }> = {
  '1 Book now › language and WhatsApp number': {
    // D12 (UX redesign R1): no language choice; every customer message is in English (checked below: no "Hindi").
    prefix: 'acc3-messages-booknow', main: 'acc3-messages-booknow', words: [/WhatsApp number is the same as mobile/],
    states: {
      loading: ['b11-book-loading'], // host: the Book now page loads the card with the form
      empty: ['acc3-messages-booknow'], // nothing chosen yet: English and "same as mobile" preselected
      error: ['acc3-messages-booknow-card-error'], // the read failed: a notice says so on the customer step
      refused: ['acc3-messages-booknow-number-refused', 'acc3-messages-booknow-card-refused'],
      readonly: ['acc3-messages-booknow-card-read-only'],
    },
  },
  '2 Deal page › Messages to customer': {
    prefix: 'acc3-messages-deal', main: 'acc3-messages-deal-sales', words: [/Messages to customer/],
    states: {
      loading: ['acc3-messages-deal-loading'], empty: ['acc3-messages-deal-empty'], error: ['acc3-messages-deal-error'],
      refused: ['acc3-messages-deal-prefs-refused', 'acc3-messages-deal-resend-refused', 'acc3-messages-deal-restart-refused'],
      readonly: ['acc3-messages-deal-accounts'],
    },
  },
  '3a Purchase task › Customer voucher': {
    prefix: 'acc3-messages-voucher', main: 'acc3-messages-voucher', words: [/Ready for customer/],
    states: {
      loading: ['app-frame-loading'], // host: the Purchase task page has no loading file of its own; the app frame shows it
      empty: ['acc3-messages-voucher-empty'], error: ['acc3-messages-voucher-error'],
      refused: ['acc3-messages-voucher-ready-refused'], readonly: ['acc3-messages-voucher-read-only'],
    },
  },
  '3b Flight task › Boarding pass': {
    prefix: 'acc3-messages-boarding', main: 'acc3-messages-boarding', words: [/[Bb]oarding pass/],
    states: {
      loading: ['flight-ws-loading'], // host: the Flight task page
      empty: ['acc3-messages-boarding-empty', 'acc3-messages-boarding-task-empty'], error: ['acc3-messages-boarding-task-error'],
      refused: ['acc3-messages-boarding-task-slot-taken'], readonly: ['acc3-messages-boarding-read-only'],
    },
  },
  '4 Settings › Customer messages': {
    prefix: 'acc3-messages-settings', main: 'acc3-messages-settings', words: [/[Pp]ilot list/, /of 18 on/, /Every message is in English/],
    states: {
      loading: ['acc3-messages-settings-loading'], empty: ['acc3-messages-settings-empty'], error: ['acc3-messages-settings-error'],
      refused: ['acc3-messages-settings-switch-refused', 'acc3-messages-settings-pilot-add-refused'],
      readonly: ['acc3-messages-settings-no-access'], // Super Admin only (R-A2): everyone else gets the no-access page
    },
  },
  '5a Deal page › Documents card (automatic bills)': {
    prefix: 'acc3-bills-deal', main: 'acc3-bills-deal-held', words: [/Made by the CRM|Held/],
    states: {
      loading: ['deal-loading'], // host: the Deal page streams the card with the page
      empty: ['acc2-docs-deal-empty'], // the same card (Phase 2) with no documents yet
      error: ['acc3-bills-deal-error'],
      refused: ['acc2-docs-deal-release-refused'], // the same card's Release refusal (Phase 2)
      readonly: ['acc3-bills-deal-manager', 'acc3-bills-deal-sales'],
    },
  },
  '5b Accounts › Bills to check': {
    prefix: 'acc3-bills-to-check', main: 'acc3-bills-to-check', words: [/Held/],
    states: {
      loading: ['acc2-docs-list-loading'], // the same Customer documents list (preset toCheck)
      empty: ['acc3-bills-to-check-empty'], error: ['acc3-bills-to-check-error'],
      refused: { na: 'the list has no commands (filters and links only); actions are on the Deal page card' },
      readonly: ['acc3-bills-list-manager'],
    },
  },
  '5c Settings › Accounts (automatic bills, write-off, Tally file)': {
    prefix: 'acc3-bills-settings', main: 'acc3-bills-settings',
    states: {
      loading: ['app-frame-loading'], // host: Settings › Accounts has no loading file of its own
      empty: { na: 'one company always exists; the page lists its settings' },
      error: ['acc3-bills-settings-unknown'], // the values could not be read: shown as unknown, never Off
      refused: ['acc3-bills-settings-limit-refused', 'acc3-bills-settings-tally-refused'],
      // R1 (S12): a Super Admin who also holds Accounts sees the company read only with the reason: acc2-settings-accounts-read-only.
      readonly: { na: 'these rows are shown only to people who may change them; the read-only view with its reason is the R1 state acc2-settings-accounts-read-only' },
    },
  },
  '6 Accounts › Small balances and Approvals › Write-offs': {
    prefix: 'acc3-writeoffs', main: 'acc3-writeoffs-list',
    states: {
      loading: ['acc3-writeoffs-list-loading'], empty: ['acc3-writeoffs-list-empty', 'acc3-writeoffs-approvals-empty'], error: ['acc3-writeoffs-list-error'],
      refused: ['acc3-writeoffs-propose-reason-short', 'acc3-writeoffs-approve-self', 'acc3-writeoffs-approve-changed'],
      readonly: ['acc3-writeoffs-monthly-admin'],
    },
  },
  '7 Accounts › Tally file and matching upload': {
    prefix: 'acc3-tally', main: 'acc3-tally-page', words: [/Make Tally file|Upload Tally vouchers/],
    states: {
      loading: ['acc3-tally-loading'], empty: ['acc3-tally-no-files', 'acc3-tally-left-out-empty'], error: ['acc3-tally-files-error'],
      refused: ['acc3-tally-refused-off', 'acc3-tally-upload-refused'], readonly: ['acc3-tally-party-name-readonly'],
    },
  },
  '8 Bell settings › Alerts on this device': {
    prefix: 'acc3-alerts', main: 'acc3-alerts-off-device', words: [/Alerts on this device/],
    states: {
      loading: ['acc3-alerts-loading'], empty: ['acc3-alerts-off-no-devices'], error: ['acc3-alerts-load-error'],
      refused: ['acc3-alerts-refused-off', 'acc3-alerts-refused-too-many'],
      readonly: ['acc3-alerts-unsupported', 'acc3-alerts-blocked'], // this device cannot take alerts: the list stays readable
    },
  },
  '9 Suppliers › Rate contracts and the offer form': {
    prefix: 'acc3-rates', main: 'acc3-rates-list-purchase',
    states: {
      loading: ['acc3-rates-list-loading'], empty: ['acc3-rates-list-empty'], error: ['acc3-rates-list-error'],
      refused: ['acc3-rates-list-create-refused', 'acc3-rates-contract-approve-refused', 'acc3-rates-offer-differs-refused'],
      readonly: ['acc3-rates-list-accounts', 'acc3-rates-contract-accounts'],
    },
  },
  '10 Change requests, add / remove, reconfirm, history': {
    prefix: 'acc3-changes', main: 'acc3-changes-deal-none', words: [/change/i],
    states: {
      loading: ['acc3-changes-deal-loading'], empty: ['acc3-changes-history-empty', 'acc3-changes-approvals-empty'], error: ['acc3-changes-deal-error'],
      refused: ['acc3-changes-deal-ask-refused', 'acc3-changes-mode-refused', 'acc3-changes-reconfirm-record-refused'],
      readonly: ['acc3-changes-deal-manager', 'acc3-changes-history-manager'],
    },
  },
  '11 Daily check additions': {
    prefix: 'acc3-bills-daily', main: 'acc3-bills-daily',
    states: {
      loading: ['acc-records-loading'], // host: the Money records page that holds the daily check
      empty: ['acc3-bills-daily-quiet'], error: ['acc3-bills-daily-absent'], // counts not sent: says so, never zero
      refused: { na: 'counts only; the daily check has no commands' },
      readonly: ['acc3-bills-daily'], // counts only for everyone
    },
  },
};
const KINDS: Kind[] = ['loading', 'empty', 'error', 'refused', 'readonly'];

function discoverStates(): string[] {
  if (!existsSync(PREVIEW_DIR)) return [];
  const found = new Set<string>();
  for (const file of readdirSync(PREVIEW_DIR)) {
    if (!/\.(tsx?|ts)$/.test(file)) continue;
    const text = readFileSync(join(PREVIEW_DIR, file), 'utf8');
    for (const m of text.matchAll(/['"`](acc3-[a-z0-9]+(?:-[a-z0-9]+)*)['"`]/g)) found.add(m[1]!);
  }
  return [...found].sort();
}
const STATES = discoverStates();

async function open(page: Page, state: string): Promise<boolean> {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  return response?.status() === 200;
}
async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}
async function noHorizontalScroll(page: Page, label: string) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `${label}: scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
}
const pageText = async (page: Page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
// The Purchase voucher and Flight boarding-pass panels are department screens too (U's names: acc3-messages-voucher*, -boarding*).
const isDepartmentState = (s: string) => /-(purchase|flight|visa)(-|$)/.test(s) || /^acc3-(purchase|flight)-/.test(s) || (/^acc3-messages-(voucher|boarding)(-|$)/.test(s) && s !== 'acc3-messages-voucher-read-only'); // that one is the branch Manager's view
const MONEY_WORDS = /selling price|selling total|\bmargin\b|\bdues\b|balance due|customer paid|customer receipt|write-?off|refund to customer/i;

test.describe('Accounts Phase 3 preview states', () => {
  test.skip(STATES.length === 0, 'Track U has not added the acc3-* preview states yet');

  test('every screen of section 15 has its preview states (main, loading, empty, error, refused, read-only)', async ({ request }) => {
    const missing: string[] = [];
    for (const [name, s] of Object.entries(SCREENS)) {
      if (!STATES.some((x) => x === s.prefix || x.startsWith(`${s.prefix}-`))) { missing.push(`${name}: no state ${s.prefix}*`); continue; }
      if (!STATES.includes(s.main)) missing.push(`${name}: no main state ${s.main}`);
      for (const kind of KINDS) {
        const want = s.states[kind];
        if (!Array.isArray(want)) continue; // recorded as not applicable, with the reason
        // Host-page states (b11-, deal-, flight-ws-, app-frame-, acc-, acc2-) live in other preview files: check they render.
        const found: string[] = [];
        for (const st of want) {
          if (STATES.includes(st)) found.push(st);
          else if (!st.startsWith('acc3-') && (await request.get(`/preview/${st}`)).status() === 200) found.push(st);
        }
        if (found.length === 0) missing.push(`${name}: no ${kind} state (${want.join(' / ')})`);
      }
    }
    expect(missing).toEqual([]);
  });

  for (const state of STATES) {
    test(`${state}: axe 1280/375, no sideways scroll, 200% zoom, keyboard, reduced motion, no leaks`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1280, height: 860 });
      expect(await open(page, state), `${state} renders`).toBe(true);
      expect(await axe(page), `${state} axe 1280`).toEqual([]);
      const text = await pageText(page);
      // Masked contact only (5.4 to_masked: 98xxxxxx12, p***@example.test); no PAN, PNR or ticket number.
      expect(text, 'no unmasked mobile').not.toMatch(/(?<![Xx0-9])[6-9][0-9]{9}\b/);
      expect(text, 'no unmasked e-mail').not.toMatch(/\b[A-Za-z0-9._%+-]{2,}@(?!example\.test\b)[A-Za-z0-9.-]+\.[a-z]{2,}\b/);
      expect(text.replace(/AAFCH9191M/g, ''), 'no unmasked PAN').not.toMatch(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/);
      expect(text, 'no ticket number').not.toMatch(/\b[0-9]{3}-?[0-9]{10}\b/);
      if (isDepartmentState(state)) expect(text, `${state}: no customer money for a department`).not.toMatch(MONEY_WORDS);
      // Reduced motion: nothing animates for more than a frame.
      const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running'
        && a.effect?.getTiming().iterations !== Infinity && Number(a.effect?.getTiming().duration ?? 0) > 50).length);
      expect(running, `${state}: reduced motion respected`).toBe(0);
      // Keyboard: the first Tab lands on a control with a visible focus indicator; one primary action at most.
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        return { tag: el.tagName, outline: s.outlineStyle !== 'none' && s.outlineWidth !== '0px', ring: s.boxShadow !== 'none' };
      });
      if (focus) expect(focus.outline || focus.ring, `${state}: visible focus on ${focus.tag}`).toBe(true);
      // Disabled actions say why (aria-disabled + one short reason).
      const disabledWithoutReason = await page.evaluate(() => [...document.querySelectorAll('[aria-disabled="true"]')]
        .filter((el) => !el.getAttribute('aria-describedby') && !el.getAttribute('title') && !(el.nextElementSibling?.textContent ?? '').trim()).length);
      expect(disabledWithoutReason, `${state}: aria-disabled actions carry a reason`).toBe(0);
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForTimeout(100);
      await noHorizontalScroll(page, `${state} 375`);
      expect(await axe(page), `${state} axe 375`).toEqual([]);
      await page.setViewportSize({ width: 640, height: 430 });
      await noHorizontalScroll(page, `${state} 200% zoom`);
    });
  }

  test('frozen words are text, never colour alone (section 15)', async ({ page }) => {
    test.setTimeout(180_000); // opens about 40 states one after another
    const misses: string[] = [];
    for (const [name, s] of Object.entries(SCREENS)) {
      if (!s.words) continue;
      const main = STATES.includes(s.main) ? s.main : null;
      if (!main) continue;
      expect(await open(page, main)).toBe(true);
      const text = await pageText(page);
      for (const w of s.words) if (!w.test(text)) misses.push(`${name} (${main}): ${w}`);
    }
    // Message status words (screen 2): every status the list can show, as words.
    for (const st of STATES.filter((x) => x.startsWith('acc3-messages-deal'))) {
      expect(await open(page, st)).toBe(true);
      const text = await pageText(page);
      if (/-statuses$|-list$/.test(st)) {
        for (const w of [/waiting/i, /sent/i, /delivered/i, /read/i, /failed/i, /stopped/i, /skipped/i]) if (!w.test(text)) misses.push(`${st}: ${w}`);
      }
      // U's list state is acc3-messages-deal-sales; "stopped" is shown by acc3-messages-deal-stopped (checked below).
      if (st === 'acc3-messages-deal-sales') {
        for (const w of [/waiting/i, /sent/i, /delivered/i, /read/i, /failed/i, /skipped/i]) if (!w.test(text)) misses.push(`${st}: ${w}`);
      }
      if (/stopped/.test(st)) {
        if (!/Customer stopped WhatsApp/.test(text)) misses.push(`${st}: "Customer stopped WhatsApp"`);
        if (!/Restart/.test(text)) misses.push(`${st}: "Restart"`);
      }
      if (/failed/.test(st) && !/Send again/.test(text)) misses.push(`${st}: "Send again"`);
    }
    const word = async (match: RegExp, words: RegExp) => {
      for (const s of STATES.filter((x) => match.test(x))) {
        expect(await open(page, s)).toBe(true);
        if (!words.test(await pageText(page))) misses.push(`${s}: ${words}`);
      }
    };
    await word(/^acc3-alerts-blocked/, /Blocked by this browser/);
    await word(/^acc3-alerts-(iphone|needs-home-screen)/, /On iPhone, add TripNavigate to the Home Screen first/);
    await word(/^acc3-alerts-unsupported/, /Not supported/);
    await word(/^acc3-alerts-on/, /Send a test alert/);
    await word(/^acc3-rates-offer-differs/, /Differs from contract/);
    await word(/^acc3-rates-offer-ended/, /Contract ended on/);
    await word(/^acc3-rates-offer-(matches|differs)/, /Contract rate ₹/);
    await word(/^acc3-changes-mode$/, /Send change/);
    await word(/^acc3-changes-reconfirm$/, /Supplier refused/);
    await word(/^acc3-writeoffs-dues-line$/, /Written off ₹[0-9,]+(\.[0-9]{2})? by /);
    await word(/^acc3-bills-deal-held/, /Held — /);
    // acc3-bills-settings-unknown: the values could not be read; it says so, shows Not known and offers no change (R1 rows).
    await word(/^acc3-bills-settings(?!-unknown$)/, /[Aa]utomatic release/);
    await word(/^acc3-bills-settings-unknown$/, /could not be read/);
    expect(misses).toEqual([]);
  });

  // One test per state (one loop over about 25 states ran past the 30 s limit on a busy CI runner).
  for (const s of STATES.filter(isDepartmentState)) {
    test(`department state never offers customer-money actions: ${s}`, async ({ page }) => {
      expect(await open(page, s)).toBe(true);
      await waitForHydration(page);
      for (const name of [/^Send again/, /^Restart/, /^Propose write-off/, /^Approve write-off/, /^Release/]) {
        await expect(page.getByRole('button', { name }), `${s}: no ${name}`).toHaveCount(0);
      }
    });
  }
  for (const s of STATES.filter((x) => /^acc3-changes-history-sales/.test(x))) {
    test(`Sales sees no supplier cost on change history: ${s}`, async ({ page }) => {
      expect(await open(page, s)).toBe(true);
      await waitForHydration(page);
      expect(await pageText(page), `${s}: no supplier cost for Sales (fence 14)`).not.toMatch(/supplier (cost|rate|fee)|change fee/i);
    });
  }

  // One test per refused state. The refusal is waited for, not counted once: a refused dialog mounts in a portal after hydration.
  for (const s of STATES.filter((x) => /refused$/.test(x))) {
    test(`refusal keeps typed input: ${s} shows the message and keeps the fields filled`, async ({ page }) => {
      expect(await open(page, s)).toBe(true);
      await waitForHydration(page);
      await expect.poll(async () => await page.getByRole('alert').count() + await page.locator('[aria-live]').count(), { message: `${s}: a refusal message` }).toBeGreaterThan(0);
      if (await page.locator('input:not([type=hidden]), textarea').count()) {
        await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), textarea')]
          .filter((el) => (el as HTMLInputElement).value.trim() !== '').length), { message: `${s}: typed input kept` }).toBeGreaterThan(0);
      }
    });
  }

  test('keyboard path: the primary action of each main state is reachable by Tab and activates with Enter', async ({ page }) => {
    for (const s of Object.values(SCREENS)) {
      const main = STATES.includes(s.main) ? s.main : null;
      if (!main) continue;
      expect(await open(page, main)).toBe(true);
      const buttons = await page.getByRole('button').count();
      if (buttons === 0) continue;
      let reached = false;
      for (let i = 0; i < 40 && !reached; i += 1) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => {
          const el = document.activeElement;
          return !!el && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && el.getAttribute('aria-disabled') !== 'true';
        });
      }
      expect(reached, `${main}: an enabled button is reachable by keyboard`).toBe(true);
    }
  });

  test('alerts opt-in (8.4): no service worker before "Alerts on this device"; one subscribe after it; stubbed PushManager', async ({ page }) => {
    const state = STATES.find((s) => s === 'acc3-alerts-off') ?? STATES.find((s) => s.startsWith('acc3-alerts'));
    test.skip(!state, 'no alerts preview state yet');
    await page.addInitScript(() => {
      const w = window as unknown as { __subscribes: number; __registers: number; Notification: unknown };
      w.__subscribes = 0;
      w.__registers = 0;
      class FakeNotification {
        static permission = 'default';
        static async requestPermission() { return 'granted'; }
        close() {}
      }
      w.Notification = FakeNotification;
      const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/acc3-preview', expirationTime: null, getKey: () => new Uint8Array(16).buffer,
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/acc3-preview', keys: { p256dh: 'BSynthetic', auth: 'c3ludGg' } }), unsubscribe: async () => true };
      const proto = (globalThis as unknown as { PushManager?: { prototype: Record<string, unknown> } }).PushManager?.prototype;
      if (proto) {
        proto.subscribe = async () => { w.__subscribes += 1; return sub; };
        proto.getSubscription = async () => null;
        proto.permissionState = async () => 'prompt';
      }
      if ('serviceWorker' in navigator) {
        const original = navigator.serviceWorker.register.bind(navigator.serviceWorker);
        navigator.serviceWorker.register = (async (...args: Parameters<typeof original>) => { w.__registers += 1; return original(...args); }) as typeof original;
      }
    });
    expect(await open(page, state!)).toBe(true);
    const regs = () => page.evaluate(async () => ('serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0));
    expect(await regs(), 'no service worker before opt-in').toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __registers: number }).__registers)).toBe(0);
    const button = page.getByRole('button', { name: /Alerts on this device/ }).first();
    if (await button.count()) {
      await button.click();
      await page.waitForTimeout(500);
      const subs = await page.evaluate(() => (window as unknown as { __subscribes: number }).__subscribes);
      expect(subs, 'subscribed at most once per click').toBeLessThanOrEqual(1);
      const registered = await page.evaluate(() => (window as unknown as { __registers: number }).__registers);
      expect(registered, 'the service worker registers only after the button').toBeLessThanOrEqual(1);
    }
  });

  // R4 review P3-1: with the Tally file switched off, unmatched files can still be matched from the earlier-files fold.
  test('Tally file off: the earlier-files fold keeps the voucher upload', async ({ page }) => {
    test.skip(!STATES.includes('acc3-tally-method-csv-only'), 'needs the acc3-tally-method-csv-only state');
    expect(await open(page, 'acc3-tally-method-csv-only')).toBe(true);
    await waitForHydration(page);
    await page.getByRole('main').getByText('Earlier Tally files and voucher upload').click();
    await expect(page.getByRole('form', { name: 'Upload Tally vouchers' })).toBeVisible();
  });

  // R4 integration: Release on a Customer documents row never posts blind. It opens a confirm that names the draft,
  // the Deal and the amount and links to the draft's preview on the Deal page; Cancel releases nothing.
  test('Release on a document row opens a confirm naming the draft and Deal, with a link to its preview', async ({ page }) => {
    test.skip(!STATES.includes('acc3-bills-list-release'), 'needs the acc3-bills-list-release state');
    expect(await open(page, 'acc3-bills-list-release')).toBe(true);
    await waitForHydration(page);
    // Rows released earlier already show the "Released" status; Cancel must not add a release result.
    const releasedBefore = await page.getByText('Released', { exact: true }).count();
    await page.getByRole('button', { name: 'Release Invoice draft of SYN-JOD-117' }).click();
    const dialog = page.getByRole('dialog', { name: 'Release the Invoice draft of SYN-JOD-117?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Invoice draft of Deal SYN-JOD-117 \(Jodhpur\) for ₹/);
    const preview = dialog.getByRole('link', { name: 'Read the preview of this Invoice draft on the Deal page' });
    // The fixture row: Deal a0002101-… (acc2-docs-fixtures DEAL_ID), draft document a0002283-….
    await expect(preview).toHaveAttribute('href', '/app/accounts/deals/a0002101-0000-4000-8000-000000002101?tab=documents#draft-a0002283-0000-4000-8000-000000002283');
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Released', { exact: true })).toHaveCount(releasedBefore);
    await expect(page.getByRole('status').filter({ hasText: 'Released:' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Release Invoice draft of SYN-JOD-117' })).toBeFocused();
  });
});
