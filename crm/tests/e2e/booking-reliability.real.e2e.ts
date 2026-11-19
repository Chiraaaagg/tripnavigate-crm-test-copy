import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type Browser, type BrowserContext, expect, type Page, type Request, test, type TestInfo } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { enrolTotpViaUi, istToday, signInViaUi, sleep, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * INVESTIGATION ONLY (booking reliability, 19 November 2026). Not a gate.
 *
 * Staff reported that Book now gets slow and shows errors before the final
 * Submit. This file replays one continuous Sales journey on a Deal at
 * "Won - Payment Received" plus five short stress cases against a REAL local
 * Supabase stack served by the production build (playwright.real.config.ts),
 * and RECORDS what a person would see: click-to-feedback and
 * click-to-completion times, every server action and refresh request
 * (status, duration), console errors, page errors and screenshots of the two
 * error surfaces ("This area could not be shown" and "Booking did not load").
 *
 * It asserts nothing about success where the right outcome is unknown: a step
 * that fails is recorded (message, screenshot, requests) and the journey goes
 * on. Results: test-results/real-journey/booking-reliability/*.json and the
 * attachments of each test. Numbers come from a GitHub runner with a local
 * Supabase stack, not from production.
 *
 * It runs ONLY when asked by name, so required jobs never run it:
 *   targeted.yml with journeys=tests/e2e/booking-reliability.real.e2e.ts
 *   (that job exports JOURNEY_FILES), or BOOKING_INVESTIGATION=1.
 * Everywhere else (ci.yml runs every *.real.e2e.ts) every test is skipped.
 *
 * Fixture steps (synthetic, local only): the Accounts journey entity and
 * users, fresh run-tagged Deals, the service_items_enabled switch for the run
 * (restored afterwards).
 */

const requested = (process.env.JOURNEY_FILES ?? '').includes('booking-reliability') || process.env.BOOKING_INVESTIGATION === '1';
const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

if (requested && configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The booking reliability investigation runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const BRANCH_CODE = 'FBR';
const PORTAL = 'SYNTHETIC_MEMBER_0001';
const SALES = { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test' } as const;
const FIXTURE_USERS = [
  { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test' },
  { id: 'a0000000-0000-4000-8000-000000000102', email: 'accounts.fin.b@example.test' },
  SALES,
] as const;
const MOBILE = '9876500099';
const WHATSAPP = '9876500098';
const TRIP = { start: '2026-12-10', end: '2026-12-13', nights: '3' } as const;
const outDir = 'test-results/real-journey/booking-reliability';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);
const CONTACT_TICK = 'I confirmed the contact details with the customer';
const SUBMIT_BUTTON = 'Submit booking and create tasks';
const SUBMIT_DIALOG = 'Submit this booking and create tasks?';
const syntheticPdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
const IDLE_MS = Number(process.env.BOOKING_INVESTIGATION_IDLE_MS ?? 360_000);

let switchWasOn: boolean | null = null;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function loadFixture(testInfo: TestInfo) {
  const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the investigation needs the 'test' deployment environment").toBe('test');
  });
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  for (const user of FIXTURE_USERS) {
    const { error } = await admin.auth.admin.createUser({ id: user.id, email: user.email, password: fixturePassword!, email_confirm: true });
    if (error && !/already/i.test(error.message)) throw new Error(`could not create ${user.email}: ${error.message}`);
  }
  await db(async (client) => {
    const { rows } = await client.query('select 1 from public.legal_entities where code = $1', [ENTITY_CODE]);
    if (rows.length === 0) {
      await client.query('begin');
      try {
        await client.query(readFileSync(fixtureFile, 'utf8'));
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    // Each test signs in afresh and enrols a new authenticator.
    await client.query('delete from auth.mfa_factors where user_id = $1', [SALES.id]);
    const { rows: s } = await client.query<{ on: boolean }>('select service_items_enabled as "on" from public.workflow_settings where id');
    if (switchWasOn === null) switchWasOn = s[0]!.on;
    await client.query(
      `select set_config('tripnavigate.change_reason', 'booking-reliability.real.e2e.ts: switch on for the investigation run', false);
       update public.workflow_settings set service_items_enabled = true where id`,
    );
  });
}

/**
 * Bitrix stand-in: a Deal header stored at "Won - Payment Received" (category 0,
 * stage UC_AD0SLH, the seeded trigger stage), as live Deals arrive from Bitrix.
 * Falls back to a CRM-native Deal header (also allowed to submit) and says so.
 */
async function newDeal(tag: string, title: string): Promise<{ id: string; kind: 'bitrix-won' | 'crm-native'; note: string | null }> {
  const sourceDealId = 800_000_000 + Number(tag.slice(-7)) + Math.floor(Math.random() * 1000);
  try {
    const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
    const recorded = await admin.rpc('integration_record_bitrix_event', { p_member_id: PORTAL, p_event_type: 'ONCRMDEALADD', p_deal_id: sourceDealId, p_source_ts: Math.floor(Date.now() / 1000) });
    if (recorded.error) throw new Error(`inbox: ${recorded.error.message}`);
    const inboxId = (recorded.data as { inboxId: string }).inboxId;
    const id = await db(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
           source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at, source_modified_at,
           last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id)
         select b.legal_entity_id, b.id, 'BX-' || $1::bigint, $2, $3, false,
           'bitrix', $4, $1, 'UC_AD0SLH', 0, now(), now(), now(), now(), $5, 9001
         from public.branches b where b.legal_entity_id = $6 and b.code = $7 returning id`,
        [sourceDealId, title, SALES.id, PORTAL, inboxId, ENTITY_ID, BRANCH_CODE],
      );
      if (rows.length !== 1) throw new Error('no branch row for the synthetic Bitrix Deal');
      return rows[0]!.id;
    });
    return { id, kind: 'bitrix-won', note: null };
  } catch (error) {
    const id = await db(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
         select b.legal_entity_id, b.id, $1, $2, $3 from public.branches b
         where b.legal_entity_id = $4 and b.code = $5 returning id`,
        [`SYN-REL-${tag}`, title, SALES.id, ENTITY_ID, BRANCH_CODE],
      );
      expect(rows, 'synthetic deal').toHaveLength(1);
      return rows[0]!.id;
    });
    return { id, kind: 'crm-native', note: `Bitrix-style Deal could not be made (${String(error).slice(0, 200)}); used a CRM-native Deal header` };
  }
}

async function signIn(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await signInViaUi(page, SALES.email, fixturePassword!);
  await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
  return page;
}

// ---------------------------------------------------------------------------
// Recorder: timings, requests, console and page errors, error surfaces
// ---------------------------------------------------------------------------

interface TimingRow {
  test: string;
  step: string;
  action: string;
  feedbackMs: number | null;
  completionMs: number | null;
  outcome: 'ok' | 'timeout' | 'error';
  note: string | null;
}
interface RequestRow {
  test: string;
  step: string;
  page: string;
  kind: 'server-action' | 'rsc' | 'document' | 'upload-or-file' | 'other';
  method: string;
  path: string;
  actionId: string | null;
  status: number | null;
  ms: number | null;
  failure: string | null;
  startedAtMs: number;
}
interface ProblemRow {
  test: string;
  step: string;
  kind: string;
  text: string;
  url: string | null;
  screenshot: string | null;
  atMs: number;
}

const SURFACES: Array<{ kind: string; text: string | RegExp }> = [
  { kind: 'area-could-not-be-shown', text: 'This area could not be shown' },
  { kind: 'booking-did-not-load', text: 'The booking did not load' },
  { kind: 'booking-did-not-load-title', text: 'Booking did not load' },
  { kind: 'page-did-not-load', text: 'This page did not load' },
  { kind: 'something-went-wrong', text: 'Something went wrong' },
  { kind: 'page-not-found', text: 'Page not found' },
  { kind: 'unknown-outcome', text: /couldn.t confirm whether it worked|could not confirm whether/i },
];

class Recorder {
  readonly timings: TimingRow[] = [];
  readonly requests: RequestRow[] = [];
  readonly problems: ProblemRow[] = [];
  readonly facts: Record<string, unknown> = {};
  readonly stepLog: Array<{ step: string; ok: boolean; ms: number; error: string | null }> = [];
  private current = 'setup';
  private readonly t0 = performance.now();
  private shots = 0;
  private readonly seen = new Set<string>();

  constructor(
    readonly name: string,
    private readonly testInfo: TestInfo,
  ) {
    mkdirSync(outDir, { recursive: true });
  }

  get step() {
    return this.current;
  }
  now() {
    return Math.round(performance.now() - this.t0);
  }

  attach(page: Page, label: string) {
    const started = new Map<Request, number>();
    const kindOf = (r: Request): RequestRow['kind'] => {
      const h = r.headers();
      if (r.method() === 'POST' && h['next-action']) return 'server-action';
      if (h['rsc'] === '1' || r.url().includes('_rsc=')) return 'rsc';
      if (r.resourceType() === 'document') return 'document';
      if (/\/files\/|\/id-proofs\//.test(r.url())) return 'upload-or-file';
      return 'other';
    };
    const interesting = (r: Request) => {
      const u = new URL(r.url());
      return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && !u.pathname.startsWith('/_next/static') && !/\.(png|svg|ico|woff2?|css|js)$/.test(u.pathname);
    };
    const done = async (r: Request, failure: string | null) => {
      const s = started.get(r);
      if (s === undefined) return;
      started.delete(r);
      let status: number | null = null;
      try {
        status = (await r.response())?.status() ?? null;
      } catch {
        status = null;
      }
      const u = new URL(r.url());
      const row: RequestRow = {
        test: this.name,
        step: this.current,
        page: label,
        kind: kindOf(r),
        method: r.method(),
        path: u.pathname,
        actionId: r.headers()['next-action']?.slice(0, 12) ?? null,
        status,
        ms: Math.round(performance.now() - this.t0 - s),
        failure,
        startedAtMs: s,
      };
      this.requests.push(row);
      if (failure || (status !== null && status >= 400)) {
        this.problem(`http-${failure ? 'failed' : status}`, `${row.method} ${row.path} (${row.kind}${row.actionId ? ` ${row.actionId}` : ''}) ${failure ?? status}`, r.url());
      }
    };
    page.on('request', (r) => {
      if (interesting(r)) started.set(r, this.now());
    });
    page.on('requestfinished', (r) => void done(r, null));
    page.on('requestfailed', (r) => void done(r, r.failure()?.errorText ?? 'failed'));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.problem(`console-${m.type()}`, m.text().slice(0, 600), page.url());
    });
    page.on('pageerror', (e) => this.problem('pageerror', `${e.name}: ${e.message}`.slice(0, 600), page.url()));
  }

  problem(kind: string, text: string, url: string | null, screenshot: string | null = null) {
    this.problems.push({ test: this.name, step: this.current, kind, text, url, screenshot, atMs: this.now() });
  }

  async shot(page: Page, label: string): Promise<string | null> {
    this.shots += 1;
    const file = `${outDir}/${this.name}-${String(this.shots).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.png`;
    try {
      await page.screenshot({ path: file, fullPage: true, timeout: 15_000 });
      return file;
    } catch {
      return null;
    }
  }

  /** Records (with a screenshot) any error surface on screen now. Never waits. */
  async surfaces(page: Page, where: string) {
    for (const s of SURFACES) {
      let n = 0;
      try {
        n = await page.getByText(s.text).count();
      } catch {
        n = 0;
      }
      if (n === 0) continue;
      const key = `${this.current}|${s.kind}|${page.url()}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const file = await this.shot(page, `surface-${s.kind}`);
      this.problem(`surface:${s.kind}`, `seen ${where}`, page.url(), file);
    }
    if (/\/sign-in|\/mfa\//.test(page.url())) {
      const key = `${this.current}|signed-out|${page.url()}`;
      if (!this.seen.has(key)) {
        this.seen.add(key);
        this.problem('surface:signed-out', `on ${new URL(page.url()).pathname} ${where}`, page.url(), await this.shot(page, 'signed-out'));
      }
    }
  }

  /** One recorded step: a failure is kept with a screenshot and the journey goes on. */
  async run(page: Page, step: string, fn: () => Promise<void>): Promise<boolean> {
    this.current = step;
    const start = performance.now();
    let ok = true;
    let error: string | null = null;
    await test.step(step, async () => {
      try {
        await fn();
      } catch (e) {
        ok = false;
        error = String(e instanceof Error ? e.message : e).split('\n').slice(0, 6).join(' | ').slice(0, 800);
        this.problem('step-failed', error, page.isClosed() ? null : page.url(), page.isClosed() ? null : await this.shot(page, `failed-${step}`));
      }
    });
    if (!page.isClosed()) await this.surfaces(page, 'after the step');
    this.stepLog.push({ step, ok, ms: Math.round(performance.now() - start), error });
    return ok;
  }

  /**
   * Times one user action. feedback: first visible reaction; completion: the
   * result the person waits for. Both are polled every 50 ms (Node clock).
   */
  async timed(action: string, act: () => Promise<unknown>, completion: () => Promise<unknown>, feedback?: () => Promise<unknown>, note: string | null = null) {
    const t = performance.now();
    let feedbackMs: number | null = null;
    let completionMs: number | null = null;
    let outcome: TimingRow['outcome'] = 'ok';
    let why = note;
    try {
      await act();
      const f = feedback
        ? feedback().then(
            () => {
              feedbackMs = Math.round(performance.now() - t);
            },
            () => undefined,
          )
        : Promise.resolve();
      await completion();
      completionMs = Math.round(performance.now() - t);
      await Promise.race([f, sleep(100)]);
      if (!feedback) feedbackMs = completionMs;
    } catch (e) {
      outcome = /Timeout|timed out/i.test(String(e)) ? 'timeout' : 'error';
      why = `${note ? `${note}; ` : ''}${String(e instanceof Error ? e.message : e).split('\n')[0]!.slice(0, 300)}`;
      this.timings.push({ test: this.name, step: this.current, action, feedbackMs, completionMs, outcome, note: why });
      throw e;
    }
    this.timings.push({ test: this.name, step: this.current, action, feedbackMs, completionMs, outcome, note: why });
  }

  async save(extra: Record<string, unknown> = {}) {
    const body = {
      test: this.name,
      note: 'GitHub runner + local Supabase stack (production build, next start). NOT production timings.',
      stepLog: this.stepLog,
      timings: this.timings,
      requests: this.requests,
      problems: this.problems,
      facts: this.facts,
      ...extra,
    };
    const file = `${outDir}/${this.name}.json`;
    writeFileSync(file, JSON.stringify(body, null, 2));
    await this.testInfo.attach(`${this.name}.json`, { path: file, contentType: 'application/json' });
    const actions = this.requests.filter((r) => r.kind === 'server-action' && r.ms !== null).map((r) => r.ms!);
    console.log(`\n[booking-reliability] ${this.name}: ${this.stepLog.filter((s) => !s.ok).length} failed steps, ${this.problems.length} problems, ${this.requests.length} requests`);
    console.table(this.stepLog.map((s) => ({ step: s.step.slice(0, 60), ok: s.ok, ms: s.ms })));
    console.table(this.timings.map((r) => ({ step: r.step.slice(0, 30), action: r.action.slice(0, 50), feedbackMs: r.feedbackMs, completionMs: r.completionMs, outcome: r.outcome })));
    if (actions.length > 0) {
      const sorted = [...actions].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
      console.log(`[booking-reliability] ${this.name}: server actions n=${sorted.length} median=${q(0.5)}ms p90=${q(0.9)}ms max=${sorted[sorted.length - 1]}ms`);
    }
    const problems = this.problems.filter((p) => !p.kind.startsWith('console-warning'));
    if (problems.length > 0) console.table(problems.slice(0, 60).map((p) => ({ step: p.step.slice(0, 30), kind: p.kind, text: p.text.slice(0, 90) })));
  }
}

/** Polls a condition every 50 ms. */
async function until(cond: () => Promise<boolean>, timeout = 30_000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try {
      ok = await cond();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > end) throw new Error(`Timeout ${timeout}ms waiting for ${what}`);
    await sleep(50);
  }
}

const footer = (page: Page) => page.locator('[data-slot="step-footer"] p').first();
const footerText = async (page: Page) => ((await footer(page).textContent({ timeout: 2_000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
const footerSettled = (page: Page, timeout = 60_000) => until(async () => /All changes saved|Not saved/.test(await footerText(page)), timeout, 'footer: All changes saved or Not saved');
const footerSaving = (page: Page, timeout = 10_000) => until(async () => /Saving/.test(await footerText(page)), timeout, 'footer: Saving…');
const pillState = (page: Page, id: string) => page.locator(`#${id}`).getAttribute('data-state', { timeout: 2_000 }).catch(() => null);
const pillIs = (page: Page, id: string, state: RegExp, timeout = 60_000) => until(async () => state.test((await pillState(page, id)) ?? ''), timeout, `${id} ${state}`);
const count = (sql: string, args: unknown[]) => db(async (c) => Number((await c.query<{ n: string }>(sql, args)).rows[0]?.n ?? '0'));

/** In-page log of every footer save text and save pill state change, with the page's own clock. */
async function watchSaveStates(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __bfLog: Array<{ t: number; what: string; value: string }> };
    w.__bfLog = [];
    const last = new Map<string, string>();
    const scan = () => {
      const f = document.querySelector('[data-slot="step-footer"] p');
      const items: Array<[string, string]> = f ? [['footer', (f.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)]] : [];
      document.querySelectorAll('[id^="pill-"]').forEach((el) => items.push([el.id, el.getAttribute('data-state') ?? '']));
      for (const [k, v] of items) {
        if (last.get(k) !== v) {
          last.set(k, v);
          w.__bfLog.push({ t: Math.round(performance.now()), what: k, value: v });
        }
      }
    };
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}
const saveStateLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __bfLog?: unknown[] }).__bfLog ?? []).catch(() => [] as unknown[]);

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

async function startBooking(rec: Recorder, page: Page, dealId: string) {
  await rec.timed(
    'open the Deal page',
    () => page.goto(`/app/deals/${dealId}`),
    () => expect(page.getByRole('button', { name: 'Start booking', exact: true })).toBeVisible({ timeout: 60_000 }),
  );
  await rec.timed(
    'Start booking → step 1 shown',
    () => page.getByRole('button', { name: 'Start booking', exact: true }).click(),
    async () => {
      await expect(page).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers`), { timeout: 60_000 });
      await expect(page.locator('main').getByLabel('Name', { exact: true })).toBeVisible({ timeout: 60_000 });
    },
  );
}

async function fillCustomer(rec: Recorder, page: Page, counts: { adults: string; children: string; infants: string }) {
  const main = page.locator('main');
  await main.getByLabel('Name', { exact: true }).pressSequentially('Synthetic Reliability Customer', { delay: 15 });
  await main.getByLabel('Phone', { exact: true }).first().pressSequentially(MOBILE, { delay: 15 });
  await main.getByLabel('Destination', { exact: true }).pressSequentially('Jodhpur', { delay: 15 });
  await main.getByLabel('Travel date').fill(TRIP.start);
  await main.getByLabel('Return date').fill(TRIP.end);
  await main.getByRole('spinbutton', { name: 'Adults' }).fill(counts.adults);
  await main.getByRole('spinbutton', { name: 'Children' }).fill(counts.children);
  await main.getByRole('spinbutton', { name: 'Infants' }).fill(counts.infants);
  await main.getByLabel('Trip', { exact: true }).selectOption('domestic');
  await rec.timed(
    'tick contact confirmed → customer card saved',
    () => main.getByLabel(CONTACT_TICK).check(),
    () => pillIs(page, 'pill-customer', /^saved$/, 60_000),
    () => pillIs(page, 'pill-customer', /saving|saved/, 10_000),
  );
}

async function nameRow(rec: Recorder, page: Page, row: number, name: string, dealId: string, expectSaved: number) {
  const box = page.locator('main').getByLabel(`Passenger ${row} full name`);
  await rec.timed(
    `type passenger ${row} name (15 ms/key) → saved in the database`,
    async () => {
      await box.fill('');
      await box.pressSequentially(name, { delay: 15 });
    },
    () => until(async () => (await count('select count(*)::text as n from public.deal_travellers where deal_id = $1', [dealId])) >= expectSaved, 60_000, `${expectSaved} travellers stored`),
    () => footerSaving(page),
  );
}

async function attachProof(rec: Recorder, page: Page, who: string, label: string, unsaved: boolean) {
  const open = page.locator('main').getByRole('button', { name: `Attach ID proof for ${who}` });
  const dialog = page.getByRole('dialog', { name: `ID proof · ${who}` });
  await rec.timed(
    `Attach ID proof (${unsaved ? 'unsaved' : 'saved'} traveller) → dialog open`,
    () => open.click(),
    () => expect(dialog).toBeVisible({ timeout: 60_000 }),
  );
  await dialog.getByLabel('ID proof file').setInputFiles([
    { name: `synthetic-${label}-front.pdf`, mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic ID front ${label}`) },
    { name: `synthetic-${label}-back.pdf`, mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic ID back ${label}`) },
  ]);
  await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
  await rec.timed(
    `upload 2 ID proof files (${unsaved ? 'unsaved' : 'saved'} traveller) → dialog closes`,
    () => dialog.getByRole('button', { name: `Attach ID proof for ${who}` }).click(),
    () => expect(dialog).toBeHidden({ timeout: 90_000 }),
    () => expect(dialog.getByRole('button', { name: /Attaching/ })).toBeVisible({ timeout: 10_000 }),
  );
}

async function gotoStep(rec: Recorder, page: Page, name: RegExp, url: RegExp, label: string) {
  await rec.timed(
    `steps bar: ${label}`,
    () => page.locator('main').getByRole('navigation', { name: 'Booking steps' }).getByRole('button', { name }).click(),
    () => expect(page).toHaveURL(url, { timeout: 60_000 }),
  );
}

async function saveMessageSettings(rec: Recorder, page: Page, label: string) {
  const card = page.locator('#book-message-prefs');
  const button = card.getByRole('button', { name: /Save message settings|Saving…/ });
  const before = (await card.textContent().catch(() => '')) ?? '';
  let result = '';
  await rec.timed(
    `Save message settings (${label})`,
    () => button.click(),
    async () => {
      await until(async () => /Save message settings/.test((await button.textContent().catch(() => '')) ?? ''), 60_000, 'button back to "Save message settings"');
      await sleep(150);
      result = ((await card.locator('[role="status"], [role="alert"]').allTextContents().catch(() => [])) ?? []).join(' | ').replace(/\s+/g, ' ').trim();
    },
    () => until(async () => /Saving…/.test((await button.textContent().catch(() => '')) ?? ''), 10_000, 'Saving…'),
  );
  rec.facts[`messageSettings:${label}`] = { result: result.slice(0, 300), changedText: before !== ((await card.textContent().catch(() => '')) ?? '') };
  return result;
}

async function dbSnapshot(dealId: string) {
  return db(async (c) => {
    const one = async (sql: string) => (await c.query<Record<string, unknown>>(sql, [dealId])).rows;
    const safe = async (sql: string) => one(sql).catch((e: unknown) => [{ error: String(e).slice(0, 160) }]);
    return {
      versions: await safe('select status, count(*)::int as n from public.booking_versions where deal_id = $1 group by status order by status'),
      travellers: await safe("select seq, traveller_type as type, full_name as name from public.deal_travellers where deal_id = $1 order by seq"),
      travellerNameDuplicates: await safe('select full_name as name, count(*)::int as n from public.deal_travellers where deal_id = $1 group by full_name having count(*) > 1'),
      idProofs: await safe('select status, count(*)::int as n from public.traveller_id_proofs where deal_id = $1 group by status order by status'),
      services: await safe("select i.service_type as type, count(*)::int as n from public.service_items i where i.deal_id = $1 group by i.service_type order by 1"),
      tasks: await safe('select count(*)::int as n from public.fulfilment_tasks where deal_id = $1'),
      accountsReview: await safe('select status, count(*)::int as n from public.accounts_booking_reviews where deal_id = $1 group by status'),
      messagePrefs: await safe('select (whatsapp_mobile is null) as same_as_mobile, row_version from public.deal_message_prefs where deal_id = $1'),
      instalments: await safe('select count(*)::int as n from public.booking_version_instalments where deal_id = $1'),
      sellingTotalPaise: await safe(`select c.selling_total_paise::text as paise, v.status from public.booking_version_commercials c join public.booking_versions v on v.id = c.version_id where v.deal_id = $1`),
    };
  });
}

async function newSalesContext(browser: Browser, rec: Recorder, label: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await watchSaveStates(context);
  const page = await signIn(context);
  rec.attach(page, label);
  return { context, page };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Keep a trace of every test (not only failures): this file records, it does not judge. File level (Playwright refuses these inside a group).
test.use({ trace: 'on', screenshot: 'on', video: 'off' });

test.describe('Booking reliability investigation @investigation', () => {
  test.skip(!requested, 'Investigation only: runs when targeted.yml names this file (JOURNEY_FILES) or BOOKING_INVESTIGATION=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    if (!requested || !configured || switchWasOn === null) return;
    await db(async (client) => {
      await client.query(`select set_config('tripnavigate.change_reason', 'booking-reliability.real.e2e.ts: restore the switch after the run', false)`);
      await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchWasOn]);
    });
  });

  test('journey: one Sales booking from Deal to Submit with timings @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(45 * 60_000);
    const rec = new Recorder('journey', testInfo);
    const tag = String(Date.now()).slice(-8);
    await loadFixture(testInfo);
    const deal = await newDeal(tag, 'Synthetic booking reliability journey');
    rec.facts.deal = { kind: deal.kind, note: deal.note };
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const names = ['Synthetic Rel Adult One', 'Synthetic Rel Adult Two', 'Synthetic Rel Child', 'Synthetic Rel Infant'];

    await rec.run(page, '01 open Deal, Start booking', () => startBooking(rec, page, deal.id));

    await rec.run(page, '02 customer card, 2 adults + 1 child + 1 infant', async () => {
      await fillCustomer(rec, page, { adults: '2', children: '1', infants: '1' });
      await expect(main.locator('[name="travellerName"]')).toHaveCount(4, { timeout: 30_000 });
    });

    await rec.run(page, '03 traveller names, rapid typing (rows 1, 3, 4)', async () => {
      await nameRow(rec, page, 1, names[0]!, deal.id, 1);
      await nameRow(rec, page, 3, names[2]!, deal.id, 2);
      await nameRow(rec, page, 4, names[3]!, deal.id, 3);
      await rec.timed('footer settles after the names', async () => undefined, () => footerSettled(page));
    });

    await rec.run(page, '04 child and infant: Details drawer, date of birth (age field noted)', async () => {
      const drawer = page.getByRole('dialog', { name: 'Passenger details' });
      for (const [row, dob] of [
        [3, '2018-05-01'],
        [4, '2026-03-01'],
      ] as const) {
        await rec.timed(`open Details for passenger ${row}`, () => main.getByRole('button', { name: `Details for passenger ${row}` }).click(), () => expect(drawer).toBeVisible({ timeout: 30_000 }));
        rec.facts[`drawer:${row}`] = {
          type: await drawer.locator('#pax-type').inputValue().catch(() => null),
          ageFieldShown: (await drawer.getByLabel('Age at travel').count()) > 0,
          dobFieldShown: (await drawer.getByLabel('Date of birth').count()) > 0,
          privateLockedText: (await drawer.getByText('Save the passenger first to add these details.').count()) > 0,
        };
        await drawer.getByLabel('Date of birth').fill(dob);
        await rec.timed(`Save passenger ${row} with date of birth → drawer closes`, () => drawer.getByRole('button', { name: 'Save passenger' }).click(), () => expect(drawer).toBeHidden({ timeout: 60_000 }));
      }
    });

    await rec.run(page, '05 ID proof: saved traveller (adult 1), two files', () => attachProof(rec, page, names[0]!, 'adult1', false));

    await rec.run(page, '06 ID proof: unsaved traveller (adult 2 typed, Attach pressed at once), two files', async () => {
      const box = main.getByLabel('Passenger 2 full name');
      await box.pressSequentially(names[1]!, { delay: 15 });
      await attachProof(rec, page, names[1]!, 'adult2', true);
    });

    await rec.run(page, '07 edit a saved name rapidly', async () => {
      const box = main.getByLabel('Passenger 1 full name');
      await rec.timed(
        'append to passenger 1 name → footer settles',
        async () => {
          await box.press('End');
          await box.pressSequentially(' Edited', { delay: 15 });
        },
        () => footerSettled(page),
        () => footerSaving(page),
      );
      names[0] = `${names[0]!} Edited`;
    });

    await rec.run(page, '08 customer messages: Save message settings twice, reload', async () => {
      const card = page.locator('#book-message-prefs');
      rec.facts.messageCardShown = (await card.count()) > 0;
      if (!rec.facts.messageCardShown) throw new Error('Messages to the customer card not on step 1');
      const same = card.getByLabel('WhatsApp number is the same as mobile');
      if (await same.isChecked()) await same.uncheck();
      await card.getByLabel('WhatsApp number').fill(WHATSAPP);
      await saveMessageSettings(rec, page, 'first save');
      await saveMessageSettings(rec, page, 'second save, no change');
      await card.getByLabel('WhatsApp number is the same as mobile').check();
      await saveMessageSettings(rec, page, 'third save, back to same as mobile');
      await rec.timed('reload step 1', () => page.reload(), () => expect(main.getByLabel('Name', { exact: true })).toBeVisible({ timeout: 60_000 }));
      rec.facts.messagePrefsAfterReload = {
        sameAsMobileTicked: await page.locator('#book-message-prefs').getByLabel('WhatsApp number is the same as mobile').isChecked().catch(() => null),
        db: (await dbSnapshot(deal.id)).messagePrefs,
      };
    });

    await rec.run(page, '09 step 2: add hotel, edit hotel', async () => {
      await rec.timed('Go to step 2', () => main.getByRole('button', { name: 'Go to step 2' }).click(), () => expect(page).toHaveURL(/\/book\/stay/, { timeout: 60_000 }));
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').pressSequentially('Jodhpur', { delay: 15 });
      await d.getByLabel('Hotel', { exact: true }).pressSequentially('Synthetic Fort View Hotel', { delay: 15 });
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('9000');
      await rec.timed('Save hotel (new) → dialog closes', () => d.getByRole('button', { name: 'Save hotel' }).click(), () => expect(d).toBeHidden({ timeout: 90_000 }));
      await expect(main).toContainText('Synthetic Fort View Hotel', { timeout: 30_000 });
      await main.getByRole('button', { name: /^Edit hotel/ }).first().click();
      const e = page.getByRole('dialog', { name: 'Edit hotel stay' });
      await e.getByLabel('Rooms: our cost per night').fill('9500');
      await e.getByLabel('Hotel', { exact: true }).pressSequentially(' Annexe', { delay: 15 });
      await rec.timed('Save hotel (edit) → dialog closes', () => e.getByRole('button', { name: 'Save hotel' }).click(), () => expect(e).toBeHidden({ timeout: 90_000 }));
    });

    await rec.run(page, '10 step 2: second service (car, full trip)', async () => {
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Cars/ }).click();
      await main.getByRole('button', { name: 'Add car', exact: true }).click();
      const car = page.getByRole('dialog', { name: 'Add car' });
      await car.getByRole('radio', { name: 'Full trip' }).click();
      await car.getByLabel('Vehicle', { exact: true }).selectOption('Innova');
      await car.getByLabel('Number of vehicles').fill('1');
      await car.getByLabel(/Rate per vehicle/).fill('12000');
      await car.getByLabel('Route', { exact: true }).fill('Jodhpur sightseeing');
      await car.getByLabel('Tour start').fill(TRIP.start);
      await car.getByLabel('Tour end').fill(TRIP.end);
      await rec.timed('Save car → dialog closes', () => car.getByRole('button', { name: 'Save car' }).click(), () => expect(car).toBeHidden({ timeout: 90_000 }));
    });

    await rec.run(page, '11 step 2: passport applicants (choose two, then Cancel)', async () => {
      const chip = main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Passport/ });
      rec.facts.passportOffered = (await chip.count()) > 0;
      if (!rec.facts.passportOffered) return;
      await chip.click();
      await main.getByRole('button', { name: 'Add passport details', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Passport requirements' });
      await expect(d).toBeVisible({ timeout: 30_000 });
      const group = d.getByRole('group', { name: /Applicant/ });
      await group.getByRole('button', { name: names[0]! }).click();
      await group.getByRole('button', { name: names[1]! }).click();
      rec.facts.passportApplicants = {
        pressedAfterChoosingTwo: await group.locator('button[aria-pressed="true"]').allTextContents(),
        whoLine: await d.locator('#svc-who-line').textContent().catch(() => null),
      };
      await rec.shot(page, 'passport-applicants');
      await d.getByRole('button', { name: 'Cancel' }).click();
      await expect(d).toBeHidden({ timeout: 30_000 });
      // Leave the empty passport section unchosen so it does not change what is submitted.
      if (await main.getByRole('button', { name: 'Add passport details', exact: true }).count()) await chip.click().catch(() => undefined);
    });

    await rec.run(page, '12 move between steps and back', async () => {
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'step 2 → step 1');
      await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'step 1 → step 3');
      await gotoStep(rec, page, /Trip & services/, /\/book\/stay/, 'step 3 → step 2');
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'step 2 → step 1');
      await expect(main.getByLabel('Passenger 1 full name')).toHaveValue(names[0]!, { timeout: 30_000 });
      await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'step 1 → step 3 (again)');
    });

    let totalRupees = 0;
    await rec.run(page, '13 step 3: package price', async () => {
      const price = main.locator('section#price');
      await price.getByLabel('Adult purchase per person, rupees').fill('20000');
      await price.getByLabel('Adult markup per person, rupees').fill('2000');
      const childBed = price.getByLabel('Child with bed: people');
      if (await childBed.count()) {
        await childBed.fill('1');
        await price.getByLabel('Child with bed purchase per person, rupees').fill('10000');
        await price.getByLabel('Child with bed markup per person, rupees').fill('1000');
      }
      const infant = price.getByLabel('Infant purchase per person, rupees');
      if (await infant.count()) {
        await infant.fill('0');
        await price.getByLabel('Infant markup per person, rupees').fill('0');
      }
      await rec.timed('price card saved', async () => undefined, () => pillIs(page, 'pill-price', /^saved$/, 60_000));
      const paise = await db(async (c) => (await c.query<{ t: string | null }>(`select c.selling_total_paise::text as t from public.booking_version_commercials c join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'draft'`, [deal.id])).rows[0]?.t ?? null);
      totalRupees = paise ? Number(paise) / 100 : 0;
      rec.facts.sellingTotalRupees = totalRupees;
    });

    await rec.run(page, '14 step 3: Bill To from the booking contact', async () => {
      const bill = main.locator('section#billTo');
      await bill.getByRole('button', { name: 'Type the details instead' }).click();
      await bill.getByRole('button', { name: 'Use booking contact' }).click();
      await bill.getByLabel('Address', { exact: true }).pressSequentially('1 Synthetic Lane', { delay: 15 });
      await bill.getByLabel('City').fill('Jodhpur');
      await bill.getByLabel('State').selectOption('08');
      await rec.timed('PIN typed → Bill To saved', () => bill.getByLabel('PIN code').fill('342001'), () => pillIs(page, 'pill-billTo', /^saved$/, 60_000), () => pillIs(page, 'pill-billTo', /saving|saved/, 10_000));
    });

    await rec.run(page, '15 step 3: payment plan equal to the total', async () => {
      const plan = main.locator('section#plan');
      await plan.getByRole('button', { name: 'Add instalment' }).click();
      await plan.getByLabel('Instalment 1', { exact: true }).fill('Full payment');
      await plan.locator('#payment-1-amount').fill(String(totalRupees || 55000));
      await rec.timed('due date typed → plan saved', () => plan.locator('#payment-1-due').fill(istToday()), () => pillIs(page, 'pill-plan', /^saved$/, 60_000), () => pillIs(page, 'pill-plan', /saving|saved/, 10_000));
      rec.facts.planText = ((await plan.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 300);
    });

    await rec.run(page, '16 step 3: acceptance evidence', async () => {
      await rec.timed(
        'choose acceptance file → shown as attached',
        () => page.getByLabel('Acceptance file').setInputFiles({ name: 'synthetic-acceptance.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic acceptance ${tag}`) }),
        () => expect(page.locator('section#ok')).toContainText('synthetic-acceptance.pdf', { timeout: 90_000 }),
      );
      rec.facts.readyBeforeIdle = ((await page.locator('#bf-ready').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
      await rec.shot(page, 'ready-before-idle');
    });

    await rec.run(page, `17 idle ${Math.round(IDLE_MS / 60_000)} minutes with the page open`, async () => {
      const end = Date.now() + IDLE_MS;
      let minute = 0;
      while (Date.now() < end) {
        await page.waitForTimeout(Math.min(60_000, end - Date.now()));
        minute += 1;
        await rec.surfaces(page, `during idle minute ${minute}`);
      }
      rec.facts.footerAfterIdle = await footerText(page);
    });

    await rec.run(page, '18 keep editing after the idle', async () => {
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'after idle: step 3 → step 1');
      const box = main.getByLabel('Passenger 2 full name');
      await rec.timed(
        'after idle: edit passenger 2 name → footer settles',
        async () => {
          await box.press('End');
          await box.pressSequentially(' Later', { delay: 15 });
        },
        () => footerSettled(page),
        () => footerSaving(page),
      );
      names[1] = `${names[1]!} Later`;
      if (await page.locator('#book-message-prefs').count()) await saveMessageSettings(rec, page, 'after idle');
      await gotoStep(rec, page, /Trip & services/, /\/book\/stay/, 'after idle: step 1 → step 2');
      await main.getByRole('button', { name: /^Edit hotel/ }).first().click();
      const e = page.getByRole('dialog', { name: 'Edit hotel stay' });
      await e.getByLabel('Rooms: our cost per night').fill('9600');
      await rec.timed('after idle: Save hotel (edit) → dialog closes', () => e.getByRole('button', { name: 'Save hotel' }).click(), () => expect(e).toBeHidden({ timeout: 90_000 }));
      await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'after idle: step 2 → step 3');
      const paise = await db(async (c) => (await c.query<{ t: string | null }>(`select c.selling_total_paise::text as t from public.booking_version_commercials c join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'draft'`, [deal.id])).rows[0]?.t ?? null);
      rec.facts.sellingTotalAfterIdle = paise ? Number(paise) / 100 : null;
      rec.facts.readyAfterIdle = ((await page.locator('#bf-ready').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
    });

    let submitted = false;
    await rec.run(page, '19 submit once', async () => {
      await main.getByRole('button', { name: 'Review and submit' }).click();
      const trigger = main.getByRole('region', { name: 'Submit' }).getByRole('button', { name: SUBMIT_BUTTON });
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      rec.facts.submitDisabled = (await trigger.getAttribute('aria-disabled')) ?? (await trigger.isDisabled() ? 'disabled' : null);
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: SUBMIT_DIALOG });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      rec.facts.submitDialog = ((await dialog.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 400);
      await rec.timed(
        'Submit booking and create tasks → Submitted page',
        () => dialog.getByRole('button', { name: SUBMIT_BUTTON }).click(),
        async () => {
          await expect(page).toHaveURL(new RegExp(`/app/deals/${deal.id}/book$`), { timeout: 120_000 });
          await expect(main).toContainText(/Submitted/, { timeout: 60_000 });
        },
        () => expect(dialog.getByRole('button', { name: /Submitting|Submit booking/ })).toBeDisabled({ timeout: 10_000 }),
      );
      submitted = true;
      await rec.shot(page, 'submitted');
    });

    await rec.run(page, '20 verify persisted booking, tasks, Accounts queue; reload', async () => {
      rec.facts.dbAfterSubmit = await dbSnapshot(deal.id);
      await rec.timed('reload the booking overview', () => page.reload(), () => expect(main).toContainText(/Submitted|Booking/, { timeout: 60_000 }));
      rec.facts.overviewAfterReload = ((await main.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 600);
      rec.facts.submittedVisibleAfterReload = (await main.getByText(/Submitted/).count()) > 0;
    });

    rec.facts.reachedPersistedSubmit = submitted && JSON.stringify(rec.facts.dbAfterSubmit ?? {}).includes('"confirmed"');
    await rec.save({ saveStateLog: await saveStateLog(page) });
    await context.close();
  });

  test('(a) repeated clicks on save and attach @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const rec = new Recorder('a-repeated-clicks', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic repeated clicks');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'setup: start, customer, one named adult', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
      await nameRow(rec, page, 1, 'Synthetic Click Adult', deal.id, 1);
      await footerSettled(page);
    });
    await rec.run(page, 'Save message settings clicked 5 times fast', async () => {
      const card = page.locator('#book-message-prefs');
      if (!(await card.count())) throw new Error('Messages to the customer card not shown');
      const before = rec.requests.filter((r) => r.kind === 'server-action').length;
      const button = card.getByRole('button', { name: /Save message settings|Saving…/ });
      for (let i = 0; i < 5; i += 1) await button.click({ delay: 0, timeout: 5_000 }).catch(() => undefined);
      await until(async () => /Save message settings/.test((await button.textContent()) ?? ''), 60_000, 'settled');
      await sleep(1_000);
      rec.facts.messageSaveActionsSent = rec.requests.filter((r) => r.kind === 'server-action').length - before;
      rec.facts.messageSaveResult = ((await card.locator('[role="status"], [role="alert"]').allTextContents()) ?? []).join(' | ');
    });
    await rec.run(page, 'Attach ID proof: attach button clicked 3 times fast', async () => {
      await main.getByRole('button', { name: 'Attach ID proof for Synthetic Click Adult' }).click();
      const dialog = page.getByRole('dialog', { name: 'ID proof · Synthetic Click Adult' });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await dialog.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-click.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('Synthetic click proof') });
      await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
      const attach = dialog.getByRole('button', { name: /Attach ID proof for|Attaching/ });
      for (let i = 0; i < 3; i += 1) await attach.click({ timeout: 3_000 }).catch(() => undefined);
      await expect(dialog).toBeHidden({ timeout: 90_000 }).catch(() => undefined);
      await sleep(1_500);
      rec.facts.storedProofsAfterTripleClick = await count("select count(*)::text as n from public.traveller_id_proofs where deal_id = $1 and status = 'stored'", [deal.id]);
    });
    await rec.run(page, 'Go to step 2 double-clicked; Save hotel double-clicked', async () => {
      await main.getByRole('button', { name: 'Go to step 2' }).dblclick();
      await expect(page).toHaveURL(/\/book\/stay/, { timeout: 60_000 });
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').fill('Jodhpur');
      await d.getByLabel('Hotel', { exact: true }).fill('Synthetic Double Click Hotel');
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('7000');
      await d.getByRole('button', { name: 'Save hotel' }).dblclick();
      await expect(d).toBeHidden({ timeout: 90_000 }).catch(() => undefined);
      await sleep(1_500);
      rec.facts.dbAfterClicks = await dbSnapshot(deal.id);
    });
    await rec.save({ saveStateLog: await saveStateLog(page) });
    await context.close();
  });

  test('(b) slow (3 s) server actions, then offline and recovery @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const rec = new Recorder('b-slow-offline', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic slow network');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'start booking (normal network)', () => startBooking(rec, page, deal.id));
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (r.method() === 'POST' && r.headers()['next-action']) await sleep(3_000);
      await route.continue().catch(() => undefined);
    });
    await rec.run(page, 'with 3 s delay: customer card and two names', async () => {
      await fillCustomer(rec, page, { adults: '2', children: '0', infants: '0' });
      await nameRow(rec, page, 1, 'Synthetic Slow Adult One', deal.id, 1);
      await nameRow(rec, page, 2, 'Synthetic Slow Adult Two', deal.id, 2);
      await rec.timed('footer settles', async () => undefined, () => footerSettled(page, 90_000));
    });
    await rec.run(page, 'with 3 s delay: Save message settings, step move', async () => {
      if (await page.locator('#book-message-prefs').count()) await saveMessageSettings(rec, page, 'slow');
      await rec.timed('Go to step 2 (slow)', () => main.getByRole('button', { name: 'Go to step 2' }).click(), () => expect(page).toHaveURL(/\/book\/stay/, { timeout: 90_000 }));
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'back to step 1 (slow)');
    });
    await rec.run(page, 'offline: edit a name, wait 15 s, see what shows', async () => {
      await context.setOffline(true);
      const box = main.getByLabel('Passenger 1 full name');
      await box.press('End');
      await box.pressSequentially(' Offline', { delay: 15 });
      await sleep(15_000);
      rec.facts.footerWhileOffline = await footerText(page);
      rec.facts.pillWhileOffline = await pillState(page, 'pill-passengers');
      await rec.shot(page, 'offline');
      await rec.surfaces(page, 'while offline');
    });
    await rec.run(page, 'back online: recovery within 60 s', async () => {
      await context.setOffline(false);
      const t = performance.now();
      await until(async () => /All changes saved/.test(await footerText(page)), 60_000, 'All changes saved after reconnect').catch((e: unknown) => rec.problem('no-recovery', String(e).slice(0, 200), page.url()));
      rec.facts.recoveryMs = Math.round(performance.now() - t);
      rec.facts.footerAfterOnline = await footerText(page);
      rec.facts.dbAfterOnline = await dbSnapshot(deal.id);
      await rec.shot(page, 'after-online');
    });
    await page.unroute('**/*');
    await rec.run(page, 'reload after recovery', async () => {
      await rec.timed('reload', () => page.reload(), () => expect(main.getByLabel('Passenger 1 full name')).toBeVisible({ timeout: 60_000 }));
      rec.facts.name1AfterReload = await main.getByLabel('Passenger 1 full name').inputValue();
    });
    await rec.save({ saveStateLog: await saveStateLog(page) });
    await context.close();
  });

  test('(c) response lost after the server saved: no duplicate traveller or task @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const rec = new Recorder('c-lost-response', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic lost response');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'setup: start, customer card saved', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '2', children: '0', infants: '0' });
      await footerSettled(page);
    });
    let mode: 'drop' | 'delay' | 'off' = 'off';
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (r.method() !== 'POST' || !r.headers()['next-action'] || mode === 'off') return route.continue().catch(() => undefined);
      if (mode === 'drop') {
        mode = 'off';
        // The server receives and completes the action; the browser never gets the answer.
        const res = await route.fetch().catch(() => null);
        rec.problem('injected-drop', `server answered ${res?.status() ?? 'nothing'}; browser got a network failure`, r.url());
        return route.abort('failed').catch(() => undefined);
      }
      mode = 'off';
      await sleep(4_000);
      return route.continue().catch(() => undefined);
    });
    await rec.run(page, 'passenger save: answer dropped after the server saved', async () => {
      mode = 'drop';
      await main.getByLabel('Passenger 1 full name').pressSequentially('Synthetic Lost Adult One', { delay: 15 });
      await sleep(8_000);
      rec.facts.footerAfterDrop = await footerText(page);
      rec.facts.pillAfterDrop = await pillState(page, 'pill-passengers');
      await rec.shot(page, 'after-drop');
      // The person types on (the next save may resend the same row).
      await main.getByLabel('Passenger 2 full name').pressSequentially('Synthetic Lost Adult Two', { delay: 15 });
      await footerSettled(page, 60_000).catch(() => undefined);
      rec.facts.travellersAfterDrop = (await dbSnapshot(deal.id)).travellers;
    });
    await rec.run(page, 'ID proof upload: answer delayed 4 s, page reloaded mid-flight', async () => {
      await main.getByRole('button', { name: 'Attach ID proof for Synthetic Lost Adult One' }).click();
      const dialog = page.getByRole('dialog', { name: 'ID proof · Synthetic Lost Adult One' });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await dialog.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-lost.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('Synthetic lost proof') });
      await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
      mode = 'delay';
      await dialog.getByRole('button', { name: 'Attach ID proof for Synthetic Lost Adult One' }).click();
      await sleep(1_500);
      await page.reload();
      await expect(main.getByLabel('Passenger 1 full name')).toBeVisible({ timeout: 60_000 });
      await sleep(4_000);
      rec.facts.proofsAfterReloadMidFlight = (await dbSnapshot(deal.id)).idProofs;
      rec.facts.rowTextAfterReload = ((await main.locator('ol[aria-label="Passengers"]').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
    });
    await rec.run(page, 'hotel save: answer dropped; the person saves again', async () => {
      await main.getByRole('button', { name: 'Go to step 2' }).click();
      await expect(page).toHaveURL(/\/book\/stay/, { timeout: 60_000 });
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').fill('Jodhpur');
      await d.getByLabel('Hotel', { exact: true }).fill('Synthetic Lost Answer Hotel');
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('8000');
      mode = 'drop';
      await d.getByRole('button', { name: 'Save hotel' }).click();
      await sleep(6_000);
      rec.facts.hotelDialogAfterDrop = { open: await d.isVisible(), text: ((await d.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(-300) };
      await rec.shot(page, 'hotel-after-drop');
      if (await d.isVisible()) {
        await d.getByRole('button', { name: 'Save hotel' }).click().catch(() => undefined);
        await expect(d).toBeHidden({ timeout: 60_000 }).catch(() => undefined);
      }
      await sleep(2_000);
      rec.facts.dbAfterHotelDrop = await dbSnapshot(deal.id);
    });
    await page.unroute('**/*');
    await rec.save({ saveStateLog: await saveStateLog(page) });
    await context.close();
  });

  test('(d) two browser windows edit the same draft (stale version) @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const rec = new Recorder('d-two-windows', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic two windows');
    const { context, page: a } = await newSalesContext(browser, rec, 'window-A');
    await rec.run(a, 'A: start, customer card, two names', async () => {
      await startBooking(rec, a, deal.id);
      await fillCustomer(rec, a, { adults: '2', children: '0', infants: '0' });
      await nameRow(rec, a, 1, 'Synthetic Window Adult One', deal.id, 1);
      await footerSettled(a);
    });
    // Same person, second window: the same session copied into a second browser context.
    const contextB = await browser.newContext({ storageState: await context.storageState() });
    await watchSaveStates(contextB);
    const b = await contextB.newPage();
    rec.attach(b, 'window-B');
    await rec.run(b, 'B: open the same draft', async () => {
      await rec.timed('B opens step 1', () => b.goto(`/app/deals/${deal.id}/book/travellers`), () => expect(b.locator('main').getByLabel('Destination', { exact: true })).toBeVisible({ timeout: 60_000 }));
    });
    await rec.run(a, 'A: change destination and a name (B is now stale)', async () => {
      await a.locator('main').getByLabel('Destination', { exact: true }).fill('Jodhpur and Jaisalmer');
      await a.locator('main').getByLabel('Passenger 2 full name').pressSequentially('Synthetic Window Adult Two A', { delay: 15 });
      await footerSettled(a);
    });
    await rec.run(b, 'B (stale): change destination and the same name', async () => {
      await b.locator('main').getByLabel('Destination', { exact: true }).fill('Jodhpur and Udaipur');
      await b.locator('main').getByLabel('Passenger 2 full name').pressSequentially('Synthetic Window Adult Two B', { delay: 15 });
      await footerSettled(b, 60_000).catch(() => undefined);
      await sleep(2_000);
      rec.facts.bFooter = await footerText(b);
      rec.facts.bPills = { customer: await pillState(b, 'pill-customer'), passengers: await pillState(b, 'pill-passengers') };
      rec.facts.bAlerts = (await b.locator('main [role="alert"], main [role="status"]').allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10);
      await rec.shot(b, 'b-stale');
    });
    await rec.run(a, 'both reload; what each shows and what is stored', async () => {
      await Promise.all([a.reload(), b.reload()]);
      await Promise.all([
        expect(a.locator('main').getByLabel('Destination', { exact: true })).toBeVisible({ timeout: 60_000 }),
        expect(b.locator('main').getByLabel('Destination', { exact: true })).toBeVisible({ timeout: 60_000 }),
      ]);
      rec.facts.afterReload = {
        a: await a.locator('main').getByLabel('Destination', { exact: true }).inputValue(),
        b: await b.locator('main').getByLabel('Destination', { exact: true }).inputValue(),
        db: await db(async (c) => (await c.query("select trip_destination as destination from public.booking_versions where deal_id = $1 and status = 'draft'", [deal.id])).rows),
        travellers: (await dbSnapshot(deal.id)).travellers,
      };
      await rec.surfaces(b, 'window B after reload');
    });
    await rec.save({ saveStateLog: { a: await saveStateLog(a), b: await saveStateLog(b) } });
    await Promise.all([context.close(), contextB.close()]);
  });

  test('(e) session cookie cleared mid-edit, then save @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const rec = new Recorder('e-session-expiry', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic session expiry');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'setup: start, customer card saved', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
      await footerSettled(page);
    });
    await rec.run(page, 'auth cookies cleared; edit destination (autosave)', async () => {
      await context.clearCookies({ name: /^sb-.*-auth-token(\.\d+)?$/ });
      await main.getByLabel('Destination', { exact: true }).fill('Jodhpur after expiry');
      await sleep(8_000);
      rec.facts.urlAfterAutosave = new URL(page.url()).pathname;
      rec.facts.footerAfterAutosave = await footerText(page);
      rec.facts.customerPill = await pillState(page, 'pill-customer');
      await rec.shot(page, 'after-autosave-signed-out');
    });
    await rec.run(page, 'press Save message settings while signed out', async () => {
      if (!(await page.locator('#book-message-prefs').count())) throw new Error('Messages to the customer card not shown');
      await saveMessageSettings(rec, page, 'signed out').catch((e: unknown) => rec.problem('save-message-signed-out', String(e).slice(0, 200), page.url()));
      await sleep(3_000);
      rec.facts.urlAfterSave = new URL(page.url()).pathname;
      await rec.shot(page, 'after-save-signed-out');
    });
    await rec.run(page, 'reload while signed out', async () => {
      await page.reload();
      await sleep(3_000);
      rec.facts.urlAfterReload = new URL(page.url()).pathname;
      rec.facts.destinationStored = await db(async (c) => (await c.query("select trip_destination as d from public.booking_versions where deal_id = $1 and status = 'draft'", [deal.id])).rows[0] ?? null);
    });
    await rec.save({ saveStateLog: await saveStateLog(page) });
    await context.close();
  });
  test('(f) A1-05 candidate: passenger 2 typed while passenger 1 save is in flight; requests per autosave @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const rec = new Recorder('f-inflight-passengers', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic in-flight passengers');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'setup: start, customer card with 3 adults', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '3', children: '0', infants: '0' });
      await footerSettled(page);
      await sleep(1_500);
    });
    await rec.run(page, 'requests fired by ONE passenger-field autosave (normal network)', async () => {
      const from = rec.requests.length;
      const t = rec.now();
      await nameRow(rec, page, 3, 'Synthetic Count Adult Three', deal.id, 1);
      await footerSettled(page);
      await sleep(2_000);
      const mine = rec.requests.slice(from).filter((r) => r.startedAtMs >= t);
      rec.facts.requestsPerSinglePassengerAutosave = {
        serverActionPosts: mine.filter((r) => r.kind === 'server-action').length,
        rscRefreshGets: mine.filter((r) => r.kind === 'rsc').length,
        other: mine.filter((r) => r.kind !== 'server-action' && r.kind !== 'rsc').map((r) => `${r.method} ${r.path}`),
        detail: mine.map((r) => ({ kind: r.kind, method: r.method, path: r.path, actionId: r.actionId, status: r.status, ms: r.ms })),
      };
    });
    let delayOn = false;
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (delayOn && r.method() === 'POST' && r.headers()['next-action']) await sleep(2_500);
      await route.continue().catch(() => undefined);
    });
    await rec.run(page, 'passenger 1 saving (response held 2.5 s) while passenger 2 is typed', async () => {
      delayOn = true;
      const from = rec.requests.length;
      await main.getByLabel('Passenger 1 full name').pressSequentially('Synthetic Flight Adult One', { delay: 15 });
      // Wait until passenger 1's save is on the wire (debounce about 700 ms), then type passenger 2.
      await until(async () => rec.requests.length > from || /Saving/.test(await footerText(page)), 5_000, 'passenger 1 save started').catch(() => undefined);
      await sleep(300);
      await main.getByLabel('Passenger 2 full name').pressSequentially('Synthetic Flight Adult Two', { delay: 15 });
      await footerSettled(page, 90_000).catch((e: unknown) => rec.problem('not-settled', String(e).slice(0, 200), page.url()));
      await sleep(3_000);
      const texts = (await main.locator('[role="alert"], [role="status"], [id$="-error"]').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      rec.facts.afterInflight = {
        footer: await footerText(page),
        pill: await pillState(page, 'pill-passengers'),
        refusalSeen: texts.filter((x) => /named passenger is missing|missing from this save|Someone changed the passengers|Reload the page/i.test(x)),
        allAlertTexts: texts.slice(0, 15),
        db: (await dbSnapshot(deal.id)).travellers,
      };
      await rec.shot(page, 'after-inflight');
    });
    await rec.run(page, 'delay off: does the refusal persist after 10 s and one more edit?', async () => {
      delayOn = false;
      await sleep(10_000);
      await main.getByLabel('Passenger 2 full name').press('End');
      await main.getByLabel('Passenger 2 full name').pressSequentially(' X', { delay: 15 });
      await footerSettled(page, 60_000).catch(() => undefined);
      await sleep(2_000);
      const texts = (await main.locator('[role="alert"], [role="status"], [id$="-error"]').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      rec.facts.afterRetry = {
        footer: await footerText(page),
        pill: await pillState(page, 'pill-passengers'),
        refusalSeen: texts.filter((x) => /named passenger is missing|missing from this save|Someone changed the passengers|Reload the page/i.test(x)),
        db: (await dbSnapshot(deal.id)).travellers,
      };
      await rec.shot(page, 'after-retry');
    });
    await page.unroute('**/*');
    await rec.save({ saveStateLog: await saveStateLog(page) });
    await context.close();
  });

  test('(g) Attach ID proof on a name with two inner spaces @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const rec = new Recorder('g-double-space-name', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic double space');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const name = 'Asha  Verma';
    await rec.run(page, 'setup: start, customer card, adult named "Asha  Verma" (two spaces), saved', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
      await nameRow(rec, page, 1, name, deal.id, 1);
      await footerSettled(page);
      rec.facts.storedName = (await dbSnapshot(deal.id)).travellers;
      rec.facts.inputValueAfterSave = await main.getByLabel('Passenger 1 full name').inputValue();
    });
    await rec.run(page, 'press Attach ID proof: does the dialog open?', async () => {
      const button = main.locator('#passengers-1-idproof-open');
      rec.facts.buttonLabel = await button.getAttribute('aria-label');
      await button.click();
      const dialog = page.getByRole('dialog', { name: /^ID proof · / });
      const opened = await dialog.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
      rec.facts.dialogOpened = opened;
      rec.facts.dialogTitle = opened ? await dialog.getByRole('heading').first().textContent() : null;
      rec.facts.rowTexts = ((await main.locator('ol[aria-label="Passengers"]').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
      await rec.shot(page, opened ? 'dialog-open' : 'dialog-not-open');
      if (opened) {
        await dialog.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-space.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('Synthetic space proof') });
        await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
        await dialog.getByRole('button', { name: /^Attach ID proof for/ }).click();
        rec.facts.closedAfterAttach = await dialog.waitFor({ state: 'hidden', timeout: 60_000 }).then(() => true, () => false);
        rec.facts.dialogTextAfterAttach = ((await dialog.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(-300);
        rec.facts.proofs = (await dbSnapshot(deal.id)).idProofs;
      }
    });
    await rec.save({ saveStateLog: await saveStateLog(page) });
    await context.close();
  });

  test('(h) hotel editor version conflict between two windows; retry in the stale one @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(15 * 60_000);
    const rec = new Recorder('h-hotel-conflict', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic hotel conflict');
    const { context, page: a } = await newSalesContext(browser, rec, 'window-A');
    const mainA = a.locator('main');
    await rec.run(a, 'A: start, customer, one adult, one hotel', async () => {
      await startBooking(rec, a, deal.id);
      await fillCustomer(rec, a, { adults: '1', children: '0', infants: '0' });
      await nameRow(rec, a, 1, 'Synthetic Conflict Adult', deal.id, 1);
      await footerSettled(a);
      await mainA.getByRole('button', { name: 'Go to step 2' }).click();
      await expect(a).toHaveURL(/\/book\/stay/, { timeout: 60_000 });
      await mainA.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await mainA.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = a.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').fill('Jodhpur');
      await d.getByLabel('Hotel', { exact: true }).fill('Synthetic Conflict Hotel');
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('7000');
      await d.getByRole('button', { name: 'Save hotel' }).click();
      await expect(d).toBeHidden({ timeout: 90_000 });
    });
    const editA = a.getByRole('dialog', { name: 'Edit hotel stay' });
    await rec.run(a, 'A: open the hotel editor and leave it open', async () => {
      await mainA.getByRole('button', { name: /^Edit hotel/ }).first().click();
      await expect(editA).toBeVisible({ timeout: 30_000 });
    });
    const contextB = await browser.newContext({ storageState: await context.storageState() });
    await watchSaveStates(contextB);
    const b = await contextB.newPage();
    rec.attach(b, 'window-B');
    await rec.run(b, 'B: change the same hotel and save', async () => {
      await b.goto(`/app/deals/${deal.id}/book/stay`);
      await b.locator('main').getByRole('button', { name: /^Edit hotel/ }).first().click();
      const e = b.getByRole('dialog', { name: 'Edit hotel stay' });
      await e.getByLabel('Rooms: our cost per night').fill('7100');
      await rec.timed('B: Save hotel', () => e.getByRole('button', { name: 'Save hotel' }).click(), () => expect(e).toBeHidden({ timeout: 90_000 }));
    });
    const dialogState = async () => ({
      open: await editA.isVisible(),
      alerts: (await editA.locator('[role="alert"], [role="status"]').allTextContents().catch(() => [] as string[])).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean),
      tail: ((await editA.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(-300),
    });
    await rec.run(a, 'A (stale): change cost, Save hotel', async () => {
      await editA.getByLabel('Rooms: our cost per night').fill('7200');
      await editA.getByRole('button', { name: 'Save hotel' }).click();
      await sleep(6_000);
      rec.facts.aFirstSave = await dialogState();
      await rec.shot(a, 'a-first-save');
    });
    await rec.run(a, 'A: press Save hotel again (retry)', async () => {
      if (!(await editA.isVisible())) {
        rec.facts.aRetry = 'dialog already closed after the first save';
        return;
      }
      await editA.getByRole('button', { name: 'Save hotel' }).click();
      await sleep(6_000);
      rec.facts.aRetry = await dialogState();
      await rec.shot(a, 'a-retry');
      if (await editA.isVisible()) {
        await editA.getByRole('button', { name: 'Save hotel' }).click();
        await sleep(6_000);
        rec.facts.aThirdTry = await dialogState();
      }
    });
    await rec.run(a, 'what is stored; A after reload', async () => {
      rec.facts.storedHotel = await db(async (c) => (await c.query(
        `select f.facts ->> 'hotelName' as hotel, f.facts ->> 'roomRatePaise' as rate_paise, f.facts as facts from public.service_item_facts f
         join public.booking_versions v on v.id = f.booking_version_id join public.service_items i on i.id = f.service_item_id
         where v.deal_id = $1 and v.status = 'draft' and i.service_type = 'hotel'`, [deal.id])).rows.map((r: Record<string, unknown>) => JSON.stringify(r).slice(0, 600)));
      await a.reload();
      await expect(mainA).toContainText('Synthetic Conflict Hotel', { timeout: 60_000 });
    });
    await rec.save({ saveStateLog: { a: await saveStateLog(a), b: await saveStateLog(b) } });
    await Promise.all([context.close(), contextB.close()]);
  });
});
