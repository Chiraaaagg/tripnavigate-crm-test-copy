import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type Browser, type BrowserContext, expect, type Page, type Request, test, type TestInfo } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { challengeViaUi, enrolTotpViaUi, signInViaUi, sleep, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Shared steps of the booking reliability INVESTIGATION (19 November 2026):
 * booking-reliability.real.e2e.ts (journey + in-flight passengers) and
 * booking-reliability-stress.real.e2e.ts (short stress cases). Not a test file
 * itself (no .real.e2e.ts suffix). Records timings, requests, console and
 * page errors and error surfaces; asserts nothing about success. Local or CI
 * stack only (loopback URLs checked).
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
export const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

/** True when targeted.yml names this file (JOURNEY_FILES) or BOOKING_INVESTIGATION=1. */
export function requestedFile(basename: string): boolean {
  return (process.env.JOURNEY_FILES ?? '').split(/\s+/).some((f) => f.endsWith(basename)) || process.env.BOOKING_INVESTIGATION === '1';
}

if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The booking reliability investigation runs only against a loopback Supabase stack and database.');
}

export const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const BRANCH_CODE = 'FBR';
const PORTAL = 'SYNTHETIC_MEMBER_0001';
export const SALES = { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test' } as const;
const FIXTURE_USERS = [
  { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test' },
  { id: 'a0000000-0000-4000-8000-000000000102', email: 'accounts.fin.b@example.test' },
  SALES,
] as const;
export const MOBILE = '9876500099';
export const WHATSAPP = '9876500098';
export const TRIP = { start: '2026-12-10', end: '2026-12-13', nights: '3' } as const;
const outDir = 'test-results/real-journey/booking-reliability';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
export const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);
export const CONTACT_TICK = 'I confirmed the contact details with the customer';
export const SUBMIT_BUTTON = 'Submit booking and create tasks';
export const SUBMIT_DIALOG = 'Submit this booking and create tasks?';
export const syntheticPdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
export const IDLE_MS = Number(process.env.BOOKING_INVESTIGATION_IDLE_MS ?? 360_000);

let switchWasOn: boolean | null = null;
let realBookingWasOn: boolean | null = null;

/** Puts service_items_enabled back as it was before the first fixture load. */
export async function restoreSwitch(file: string) {
  if (!configured || switchWasOn === null) return;
  await db(async (client) => {
    await client.query(`select set_config('tripnavigate.change_reason', $1, false)`, [`${file}: restore the switch after the run`]);
    await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchWasOn]);
    if (realBookingWasOn !== null) await client.query('update public.booking_settings set real_booking_enabled = $1 where id', [realBookingWasOn]);
  });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export async function loadFixture(testInfo: TestInfo) {
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
    // Production has this gate ON (lead, read-only check, 19 Nov 2026); the CI fixture starts it off
    // (booking_synthetic.sql). Opened for the run as b12-quote-to-booking.real.e2e.ts does; restored afterwards.
    const { rows: r } = await client.query<{ on: boolean }>('select real_booking_enabled as "on" from public.booking_settings where id');
    if (realBookingWasOn === null) realBookingWasOn = r[0]!.on;
    await client.query(
      `select set_config('tripnavigate.change_reason', 'booking-reliability: local real-Deal booking gate on for the run (production has it on)', false);
       update public.booking_settings set real_booking_enabled = true where id`,
    );
  });
}

/**
 * Bitrix stand-in: a Deal header stored at "Won - Payment Received" (category 0,
 * stage UC_AD0SLH, the seeded trigger stage), as live Deals arrive from Bitrix.
 * Falls back to a CRM-native Deal header (also allowed to submit) and says so.
 */
export async function newDeal(tag: string, title: string, opts: { kind?: 'bitrix-won' | 'crm-native' } = {}): Promise<{ id: string; kind: 'bitrix-won' | 'crm-native'; note: string | null }> {
  const sourceDealId = 800_000_000 + Number(tag.slice(-7)) + Math.floor(Math.random() * 1000);
  try {
    // A CRM-native header is synthetic (deals.is_synthetic default true): the only kind the
    // 'test' environment's finance gate lets into Accounts reads (authz.finance_gate_issue).
    if (opts.kind === 'crm-native') throw new Error('CRM-native Deal asked for');
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

export async function signIn(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await signInViaUi(page, SALES.email, fixturePassword!);
  await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
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
  /** Server actions only: the end of the answer (synthetic data), to see refusal codes. */
  body: string | null;
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

export class Recorder {
  readonly timings: TimingRow[] = [];
  readonly requestsPerAction: Array<{ test: string; step: string; action: string; serverActions: number; rscRefreshes: number; documents: number; other: number }> = [];
  readonly requests: RequestRow[] = [];
  readonly problems: ProblemRow[] = [];
  readonly facts: Record<string, unknown> = {};
  readonly stepLog: Array<{ step: string; ok: boolean; ms: number; error: string | null }> = [];
  private current = 'setup';
  private readonly t0 = performance.now();
  private shots = 0;
  private readonly seen = new Set<string>();
  private readonly pages: Array<{ label: string; page: Page }> = [];
  private consecutiveFails = 0;
  private stopped: string | null = null;
  saved = false;

  constructor(
    readonly name: string,
    private readonly testInfo: TestInfo,
  ) {
    mkdirSync(outDir, { recursive: true });
    Recorder.active = this;
  }

  /** The recorder of the running test (saved by afterEach when a test times out). */
  static active: Recorder | null = null;

  /** Clears the fail-fast counter after a deliberate recovery step. */
  resume() {
    this.consecutiveFails = 0;
    this.stopped = null;
  }

  get step() {
    return this.current;
  }
  now() {
    return Math.round(performance.now() - this.t0);
  }

  attach(page: Page, label: string) {
    this.pages.push({ label, page });
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
      let body: string | null = null;
      if (kindOf(r) === 'server-action' && !failure) {
        body = await Promise.race([
          r.response().then((res) => res?.text() ?? null).catch(() => null),
          sleep(3_000).then(() => null),
        ]);
        body = body ? body.replace(/\s+/g, ' ').slice(-400) : null;
      }
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
        body,
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
    page.on('pageerror', (e) => this.problem('pageerror', `${e.name}: ${e.message} | stack: ${(e.stack ?? '').split('\n').slice(0, 12).join(' / ')}`.slice(0, 1500), page.url()));
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
  async run(page: Page, step: string, fn: () => Promise<void>, opts: { always?: boolean } = {}): Promise<boolean> {
    this.current = step;
    if (this.stopped && !opts.always) {
      this.stepLog.push({ step, ok: false, ms: 0, error: `not run: ${this.stopped}` });
      return false;
    }
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
    this.consecutiveFails = ok ? 0 : this.consecutiveFails + 1;
    if (this.consecutiveFails >= 2 && !this.stopped) {
      this.stopped = `two steps in a row failed (last: ${step})`;
      this.problem('test-stopped', this.stopped, page.isClosed() ? null : page.url());
    }
    return ok;
  }

  /**
   * Times one user action. feedback: first visible reaction; completion: the
   * result the person waits for. Both are polled every 50 ms (Node clock).
   */
  async timed(action: string, act: () => Promise<unknown>, completion: () => Promise<unknown>, feedback?: () => Promise<unknown>, note: string | null = null) {
    const t = performance.now();
    const fromMs = this.now();
    const countRequests = async () => {
      // Requests started during the action, counted once their answers are in (or after 1.5 s).
      await sleep(1_500);
      const mine = this.requests.filter((r) => r.startedAtMs >= fromMs);
      this.requestsPerAction.push({
        test: this.name,
        step: this.current,
        action,
        serverActions: mine.filter((r) => r.kind === 'server-action').length,
        rscRefreshes: mine.filter((r) => r.kind === 'rsc').length,
        documents: mine.filter((r) => r.kind === 'document').length,
        other: mine.filter((r) => r.kind === 'other' || r.kind === 'upload-or-file').length,
      });
    };
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
      await countRequests();
      throw e;
    }
    this.timings.push({ test: this.name, step: this.current, action, feedbackMs, completionMs, outcome, note: why });
    await countRequests();
  }

  async save(extra: Record<string, unknown> = {}) {
    if (this.saved) return;
    this.saved = true;
    const saveStateLogs: Record<string, unknown> = {};
    for (const { label, page } of this.pages) {
      saveStateLogs[label] = page.isClosed() ? 'page closed' : await Promise.race([saveStateLog(page), sleep(5_000).then(() => 'timed out')]);
    }
    const body = {
      saveStateLogs,
      requestsPerAction: this.requestsPerAction,
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
    console.table(this.requestsPerAction.map((r) => ({ action: r.action.slice(0, 50), serverActions: r.serverActions, rscRefreshes: r.rscRefreshes, documents: r.documents, other: r.other })));
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
export async function until(cond: () => Promise<boolean>, timeout = 30_000, what = 'condition'): Promise<void> {
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

export const footer = (page: Page) => page.locator('[data-slot="step-footer"] p').first();
export const footerText = async (page: Page) => ((await footer(page).textContent({ timeout: 2_000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
export const footerSettled = (page: Page, timeout = 30_000) => until(async () => /All changes saved|Not saved/.test(await footerText(page)), timeout, 'footer: All changes saved or Not saved');
export const footerSaving = (page: Page, timeout = 10_000) => until(async () => /Saving/.test(await footerText(page)), timeout, 'footer: Saving…');
export const pillState = (page: Page, id: string) => page.locator(`#${id}`).getAttribute('data-state', { timeout: 2_000 }).catch(() => null);
export const pillIs = (page: Page, id: string, state: RegExp, timeout = 30_000) => until(async () => state.test((await pillState(page, id)) ?? ''), timeout, `${id} ${state}`);
export const count = (sql: string, args: unknown[]) => db(async (c) => Number((await c.query<{ n: string }>(sql, args)).rows[0]?.n ?? '0'));

/** In-page log of every footer save text and save pill state change, with the page's own clock. */
export async function watchSaveStates(context: BrowserContext) {
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
export const saveStateLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __bfLog?: unknown[] }).__bfLog ?? []).catch(() => [] as unknown[]);

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

export async function startBooking(rec: Recorder, page: Page, dealId: string) {
  await rec.timed(
    'open the Deal page',
    () => page.goto(`/app/deals/${dealId}`),
    () => expect(page.getByRole('button', { name: 'Start booking', exact: true })).toBeVisible({ timeout: 30_000 }),
  );
  await rec.timed(
    'Start booking → step 1 shown',
    () => page.getByRole('button', { name: 'Start booking', exact: true }).click(),
    async () => {
      await expect(page).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers`), { timeout: 30_000 });
      await expect(page.locator('main').getByLabel('Name', { exact: true })).toBeVisible({ timeout: 30_000 });
    },
  );
}

export async function fillCustomer(rec: Recorder, page: Page, counts: { adults: string; children: string; infants: string }) {
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
    () => pillIs(page, 'pill-customer', /^saved$/, 30_000),
    () => pillIs(page, 'pill-customer', /saving|saved/, 10_000),
  );
}

export async function nameRow(rec: Recorder, page: Page, row: number, name: string, dealId: string, expectSaved: number) {
  const box = page.locator('main').getByLabel(`Passenger ${row} full name`);
  await rec.timed(
    `type passenger ${row} name (15 ms/key) → saved in the database`,
    async () => {
      await box.fill('');
      await box.pressSequentially(name, { delay: 15 });
    },
    () => until(async () => (await count('select count(*)::text as n from public.deal_travellers where deal_id = $1', [dealId])) >= expectSaved, 30_000, `${expectSaved} travellers stored`),
    () => footerSaving(page),
  );
}

export async function attachProof(rec: Recorder, page: Page, who: string, label: string, unsaved: boolean) {
  const open = page.locator('main').getByRole('button', { name: `Attach ID proof for ${who}` });
  const dialog = page.getByRole('dialog', { name: `ID proof · ${who}` });
  await rec.timed(
    `Attach ID proof (${unsaved ? 'unsaved' : 'saved'} traveller) → dialog open`,
    () => open.click(),
    () => expect(dialog).toBeVisible({ timeout: 30_000 }),
  );
  await dialog.getByLabel('ID proof file').setInputFiles([
    { name: `synthetic-${label}-front.pdf`, mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic ID front ${label}`) },
    { name: `synthetic-${label}-back.pdf`, mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic ID back ${label}`) },
  ]);
  await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
  await rec.timed(
    `upload 2 ID proof files (${unsaved ? 'unsaved' : 'saved'} traveller) → dialog closes`,
    () => dialog.getByRole('button', { name: `Attach ID proof for ${who}` }).click(),
    () => expect(dialog).toBeHidden({ timeout: 30_000 }),
    () => expect(dialog.getByRole('button', { name: /Attaching/ })).toBeVisible({ timeout: 10_000 }),
  );
}

export async function gotoStep(rec: Recorder, page: Page, name: RegExp, url: RegExp, label: string) {
  await rec.timed(
    `steps bar: ${label}`,
    () => page.locator('main').getByRole('navigation', { name: 'Booking steps' }).getByRole('button', { name }).click(),
    () => expect(page).toHaveURL(url, { timeout: 30_000 }),
  );
}

export async function saveMessageSettings(rec: Recorder, page: Page, label: string) {
  const card = page.locator('#book-message-prefs');
  const button = card.getByRole('button', { name: /Save message settings|Saving…/ });
  const before = (await card.textContent().catch(() => '')) ?? '';
  let result = '';
  await rec.timed(
    `Save message settings (${label})`,
    () => button.click(),
    async () => {
      await until(async () => /Save message settings/.test((await button.textContent().catch(() => '')) ?? ''), 30_000, 'button back to "Save message settings"');
      await sleep(150);
      result = ((await card.locator('[role="status"], [role="alert"]').allTextContents().catch(() => [])) ?? []).join(' | ').replace(/\s+/g, ' ').trim();
    },
    () => until(async () => /Saving…/.test((await button.textContent().catch(() => '')) ?? ''), 10_000, 'Saving…'),
  );
  rec.facts[`messageSettings:${label}`] = { result: result.slice(0, 300), changedText: before !== ((await card.textContent().catch(() => '')) ?? '') };
  return result;
}

export async function dbSnapshot(dealId: string) {
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

export async function newSalesContext(browser: Browser, rec: Recorder, label: string): Promise<{ context: BrowserContext; page: Page; secret: string }> {
  const context = await browser.newContext();
  await watchSaveStates(context);
  const { page, secret } = await signInKeepSecret(context);
  rec.attach(page, label);
  return { context, page, secret };
}

/** As signIn(), and returns the authenticator secret so the same person can sign in again (B1-8 journeys). */
export async function signInKeepSecret(context: BrowserContext): Promise<{ page: Page; secret: string }> {
  const page = await context.newPage();
  await signInViaUi(page, SALES.email, fixturePassword!);
  const secret = await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
  return { page, secret };
}

/**
 * Signs the Sales user in again in a NEW tab of the same browser context (the
 * "sign in again in another tab" step of B1-8): the old auth cookies are
 * removed first, then password and the existing authenticator. The tab is
 * closed afterwards; the other tabs share the new session cookies.
 */
export async function signInAgainInNewTab(context: BrowserContext, secret: string): Promise<void> {
  await context.clearCookies({ name: /^sb-.*-auth-token(\.\d+)?$/ });
  const tab = await context.newPage();
  try {
    await signInViaUi(tab, SALES.email, fixturePassword!);
    await challengeViaUi(tab, secret);
    await expect(tab).toHaveURL(/\/app$/, { timeout: 30_000 });
  } finally {
    await tab.close();
  }
}


const REFUSAL = /named passenger is missing|Reload the page to see everyone|Someone changed the passengers/i;

/** Texts of alerts and field errors in main (for refusals). */
/** Values of the passenger name boxes, in screen order. */
export async function rowValues(page: Page): Promise<string[]> {
  return page.locator('main [name="travellerName"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)).catch(() => [] as string[]);
}

export async function mainAlerts(page: Page): Promise<string[]> {
  const texts = await page.locator('main [role="alert"], main [role="status"], main [id$="-error"]').allTextContents().catch(() => [] as string[]);
  return texts.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20);
}

export async function refusalOnScreen(page: Page): Promise<string[]> {
  return (await mainAlerts(page)).filter((x) => REFUSAL.test(x));
}

/**
 * After a passengers refusal: records what Reload does (which saved rows come back,
 * which typed names are lost), then types the missing names again so the journey can go on.
 */
export async function reloadAfterRefusal(rec: Recorder, page: Page, dealId: string, intended: string[]) {
  const main = page.locator('main');
  const rows = main.locator('[name="travellerName"]');
  const typedBefore = await rows.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)).catch(() => [] as string[]);
  const dbBefore = (await dbSnapshot(dealId)).travellers;
  const reloadButtons = await page.getByRole('button', { name: /Reload/ }).count();
  await rec.shot(page, 'refusal-before-reload');
  await rec.timed('Reload after the refusal', () => (reloadButtons > 0 ? page.getByRole('button', { name: /Reload/ }).first().click() : page.reload()), () => expect(rows.first()).toBeVisible({ timeout: 30_000 }));
  await sleep(1_500);
  const typedAfter = await rows.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)).catch(() => [] as string[]);
  const dbAfter = (await dbSnapshot(dealId)).travellers;
  rec.facts[`reloadAfterRefusal:${rec.step}`] = {
    recentServerActions: rec.requests.filter((r) => r.kind === 'server-action').slice(-6).map((r) => ({ path: r.path, actionId: r.actionId, status: r.status, ms: r.ms, failure: r.failure, body: r.body })),
    usedReloadButton: reloadButtons > 0,
    typedBefore,
    dbBefore,
    typedAfter,
    dbAfter,
    typedNamesLost: typedBefore.filter((n) => n.trim() && !typedAfter.includes(n)),
    refusalStillShown: await refusalOnScreen(page),
    pill: await pillState(page, 'pill-passengers'),
    footer: await footerText(page),
  };
  await rec.shot(page, 'refusal-after-reload');
  // Type back what is missing, one row at a time, waiting for each save.
  for (const [i, name] of intended.entries()) {
    if (!name) continue;
    const box = main.getByLabel(`Passenger ${i + 1} full name`);
    if ((await box.inputValue().catch(() => '')) === name) continue;
    await box.fill('');
    await box.pressSequentially(name, { delay: 15 });
    await footerSettled(page, 30_000).catch(() => undefined);
    await sleep(800);
  }
  rec.facts[`afterRetype:${rec.step}`] = { db: (await dbSnapshot(dealId)).travellers, refusal: await refusalOnScreen(page), footer: await footerText(page) };
}


// ---------------------------------------------------------------------------
// Fix batch 1 journeys (tests/e2e/br-*.real.e2e.ts): shared helpers
// ---------------------------------------------------------------------------

/** True when targeted.yml names the file, or BR_JOURNEYS=1 (all fix batch 1 journeys). */
export function requestedBrFile(basename: string): boolean {
  return requestedFile(basename) || process.env.BR_JOURNEYS === '1';
}

/**
 * Test-only fault switch IN THE DISPOSABLE DATABASE (build contract B1-3: "never
 * in product code"). Replaces every public function of that name with one that
 * raises SQLSTATE 57014 (statement cancelled), keeping its arguments, result
 * type, volatility and grants; restoreFaults() puts the exact original
 * definitions (pg_get_functiondef) back. Loopback database only (checked at
 * the top of this file).
 */
const faultOriginals = new Map<string, string[]>();
export async function installFault(fn: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`not a plain function name: ${fn}`);
  await db(async (c) => {
    const { rows } = await c.query<{ def: string; args: string; res: string; vol: string }>(
      `select pg_get_functiondef(p.oid) as def, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as res,
              case p.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end as vol
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [fn],
    );
    if (rows.length === 0) throw new Error(`no public.${fn} to fault`);
    if (!faultOriginals.has(fn)) faultOriginals.set(fn, rows.map((r) => r.def));
    for (const r of rows) {
      await c.query(
        `create or replace function public.${fn}(${r.args}) returns ${r.res} language plpgsql ${r.vol} as $br_fault$
         begin raise exception 'br_test_fault' using errcode = '57014'; end $br_fault$`,
      );
    }
  });
}
export async function restoreFaults(only?: string): Promise<void> {
  const names = only ? [only] : [...faultOriginals.keys()];
  await db(async (c) => {
    for (const fn of names) {
      for (const def of faultOriginals.get(fn) ?? []) await c.query(def);
      faultOriginals.delete(fn);
    }
  });
}

export interface SeenRequest {
  atMs: number;
  method: string;
  path: string;
  kind: 'server-action' | 'prefetch' | 'rsc' | 'document' | 'other';
}

/** Every app request of a page (same classification as measurement M0). */
export function watchRequests(page: Page): SeenRequest[] {
  const t0 = Date.now();
  const seen: SeenRequest[] = [];
  const kindOf = (r: Request): SeenRequest['kind'] => {
    const h = r.headers();
    if (r.method() === 'POST' && h['next-action']) return 'server-action';
    if (h['next-router-prefetch'] || h['purpose'] === 'prefetch') return 'prefetch';
    if (h['rsc'] === '1' || r.url().includes('_rsc=')) return 'rsc';
    if (r.resourceType() === 'document') return 'document';
    return 'other';
  };
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return;
    if (u.pathname.startsWith('/_next/static') || /\.(png|svg|ico|woff2?|css|js)$/.test(u.pathname)) return;
    seen.push({ atMs: Date.now() - t0, method: r.method(), path: u.pathname, kind: kindOf(r) });
  });
  return seen;
}

export function requestSummary(rows: SeenRequest[]) {
  const of = (k: SeenRequest['kind']) => rows.filter((r) => r.kind === k);
  return {
    serverActionPosts: of('server-action').length,
    pageGets: of('rsc').length + of('document').length,
    prefetchGets: of('prefetch').length,
    detail: rows.map((r) => `${r.atMs} ${r.kind} ${r.method} ${r.path}`),
  };
}

/** Data API calls per function so far (pg_stat_statements, top-level statements only). */
export async function dataApiCalls(fns: readonly string[]): Promise<Record<string, number>> {
  return db(async (c) => {
    await c.query('create extension if not exists pg_stat_statements with schema extensions').catch(() => undefined);
    const out: Record<string, number> = {};
    for (const fn of fns) {
      const { rows } = await c.query<{ n: string }>(
        `select coalesce(sum(calls), 0)::text as n from extensions.pg_stat_statements
          where query ilike '%' || $1 || '%' and query not ilike '%pg_stat_statements%'`,
        [`"${fn}"`],
      );
      out[fn] = Number(rows[0]?.n ?? '0');
    }
    return out;
  });
}

/** Stored passenger names of a Deal, in passenger-number order. */
export async function storedNames(dealId: string): Promise<string[]> {
  return db(async (c) => (await c.query<{ n: string }>('select full_name as n from public.deal_travellers where deal_id = $1 order by seq', [dealId])).rows.map((r) => r.n));
}

/** Stored hotels of the draft: their facts as text (holds the hotel name) and room rate (paise). */
export async function storedHotels(dealId: string): Promise<Array<{ facts: string | null; ratePaise: string | null }>> {
  return db(async (c) =>
    (
      await c.query<{ facts: string | null; rate: string | null }>(
        `select f.facts::text as facts, e.room_rate_paise::text as rate
           from public.service_items i
           join public.booking_versions v on v.deal_id = i.deal_id and v.status = 'draft'
           left join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = v.id
           left join public.service_item_cost_estimates e on e.service_item_id = i.id and e.booking_version_id = v.id
          where i.deal_id = $1 and i.service_type = 'hotel' order by i.created_at`,
        [dealId],
      )
    ).rows.map((r) => ({ facts: r.facts, ratePaise: r.rate })),
  );
}

export async function storedDestination(dealId: string): Promise<string | null> {
  return db(async (c) => (await c.query<{ d: string | null }>("select trip_destination as d from public.booking_versions where deal_id = $1 and status = 'draft'", [dealId])).rows[0]?.d ?? null);
}

/** Step 1 → step 2, choose Hotels (unless already chosen), add one hotel and save it (dialog closes). */
export async function addHotel(page: Page, hotel: string, rateRupees: string, opts: { chooseHotels?: boolean } = {}) {
  const main = page.locator('main');
  if (!/\/book\/stay/.test(page.url())) {
    await main.getByRole('button', { name: 'Go to step 2' }).click();
    await expect(page).toHaveURL(/\/book\/stay/, { timeout: 30_000 });
  }
  if (opts.chooseHotels !== false) await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
  await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Add hotel stay' });
  await d.getByLabel('City').fill('Jodhpur');
  await d.getByLabel('Hotel', { exact: true }).fill(hotel);
  await d.getByLabel('Check-in').fill(TRIP.start);
  await d.getByLabel('Nights').fill(TRIP.nights);
  await d.getByLabel('Rooms: our cost per night').fill(rateRupees);
  await d.getByRole('button', { name: 'Save hotel' }).click();
  await expect(d).toBeHidden({ timeout: 30_000 });
}

/** Page errors (uncaught exceptions) the recorder saw, e.g. "Maximum call stack size exceeded" (BR-25). */
export function pageErrors(rec: Recorder): string[] {
  return rec.problems.filter((p) => p.kind === 'pageerror').map((p) => p.text.slice(0, 200));
}

/** Saves the active recorder of a test that ended early (assertion journeys fail fast). */
export async function saveActiveRecorder() {
  const rec = Recorder.active;
  Recorder.active = null;
  if (rec && !rec.saved) await rec.save({ endedBy: 'afterEach (assertion failed or timeout before the end of the test)' }).catch(() => undefined);
}

export { sleep };
