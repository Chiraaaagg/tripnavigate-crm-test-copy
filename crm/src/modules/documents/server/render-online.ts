import 'server-only';
import { randomUUID } from 'node:crypto';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { checkBearer } from '@/modules/integration/bitrix/auth';
import { MIN_WORKER_SECRET_LENGTH } from '@/modules/integration/bitrix/config';
import {
  RENDERED_BUCKET,
  itineraryRenderClaimForWorker,
  itineraryRenderCompleteForWorker,
  itineraryRenderInputForWorker,
} from '@/modules/itineraries/server/render-worker';
import { scanText } from '../safety';
import { createUrlPdfRenderer, type PrintPageCheck, type UrlPdfBrowser } from '../render/pdf-url';
import { MIN_PRINT_TOKEN_SECRET_LENGTH, PDF_RENDER_ONLINE_ENV, PRINT_TOKEN_HEADER, signPrintToken } from '../render/print-token';
import { customerRenderClaim, customerRenderComplete, customerRenderInput, type CustomerRenderRpc } from '../render/customer-job-input';
import { processOneCustomerJob, processOneJob, type CustomerJobOutcome, type CustomerWorkerDeps, type JobOutcome, type WorkerDeps } from '../render/worker-core';
import { istDate } from './load-quotation-view';

/**
 * DEC-49: the ONLINE PDF maker (built, not deployed). One request renders at
 * most one queued itinerary job inside a Vercel Function:
 *
 *   claim (Terra's service-role wrapper, lease 120 s) -> render input ->
 *   adapter (same as the request) -> headless Chromium opens the in-app print
 *   page /print/itinerary/<job> (signed 2-minute token in a request header) -> page checks on the
 *   template markup -> PDF with JavaScript off -> private upload -> complete.
 *
 * Off unless PDF_RENDER_ONLINE is "on" (server env; switching it on is an
 * APPROVE). Chromium: @sparticuz/chromium 153.0.0 on Vercel (Linux binary,
 * matching Playwright 1.63.0's Chromium 153), Playwright's own cached
 * Chromium everywhere else (local fallback). Nothing here logs; the reply is
 * codes, sizes and timings only. The print link (it carries the token) and
 * every secret stay inside this module and Chromium.
 */

export { PDF_RENDER_ONLINE_ENV } from '../render/print-token';
export const ONLINE_LEASE_SECONDS = 120;

export interface OnlineRenderEnv {
  on: boolean;
  printTokenSecret: string | null;
  /** The app's own origin (NEXT_PUBLIC_SITE_URL), never the request's Host header. */
  siteUrl: string | null;
  workerSecret: string | null;
  cronSecret: string | null;
}

export function getOnlineRenderEnv(): OnlineRenderEnv {
  let siteUrl: string | null = null;
  try {
    siteUrl = getAppConfig().siteUrl;
  } catch {
    siteUrl = null;
  }
  return {
    on: process.env[PDF_RENDER_ONLINE_ENV] === 'on',
    printTokenSecret: process.env.RENDER_PRINT_TOKEN_SECRET ?? null,
    siteUrl,
    workerSecret: process.env.RENDER_WORKER_SECRET ?? null,
    cronSecret: process.env.CRON_SECRET ?? null,
  };
}

export type OnlineRunResult =
  | { status: 'switched_off' }
  | { status: 'not_configured'; code: 'print_token_secret_missing' | 'site_url_missing' }
  | { status: 'browser_unavailable' }
  | { status: 'ran'; outcome: JobOutcome; launchMs: number };

/** Headless Chromium: the serverless build on Vercel, Playwright's own elsewhere. */
export async function launchChromium(): Promise<UrlPdfBrowser & { close(): Promise<void> }> {
  const { chromium } = await import('playwright-core');
  if (process.env.VERCEL) {
    const serverless = (await import('@sparticuz/chromium')).default;
    serverless.setGraphicsMode = false;
    return chromium.launch({ executablePath: await serverless.executablePath(), args: serverless.args, headless: true });
  }
  return chromium.launch({ headless: true });
}

export interface OnlineRunDeps {
  env: OnlineRenderEnv;
  launch(): Promise<UrlPdfBrowser & { close(): Promise<void> }>;
  /** Claim/input/complete/upload (service role); injected for tests. */
  supabase(worker: string): Pick<WorkerDeps, 'claim' | 'input' | 'complete' | 'upload'>;
  /** Customer document queue (Accounts phase 2); drained after an idle itinerary run when given (production: service role). */
  customerSupabase?: (worker: string) => Pick<CustomerWorkerDeps, 'claim' | 'input' | 'complete' | 'upload'>;
  now(): number;
  today(): string;
}

export function serviceRoleJobDeps(worker: string): Pick<WorkerDeps, 'claim' | 'input' | 'complete' | 'upload'> {
  const admin = createSupabaseAdminClient();
  const rpc = asRpcClient(admin);
  return {
    claim: () => itineraryRenderClaimForWorker({ worker, leaseSeconds: ONLINE_LEASE_SECONDS }, rpc),
    input: (jobId) => itineraryRenderInputForWorker({ jobId, worker }, rpc),
    upload: async (objectPath, pdf) => {
      const { error } = await admin.storage.from(RENDERED_BUCKET).upload(objectPath, pdf, { contentType: 'application/pdf', upsert: true });
      if (error) throw new Error('upload failed');
    },
    complete: (jobId, ok, errorCode, file) =>
      itineraryRenderCompleteForWorker({ jobId, worker, outcome: ok && file ? { ok: true, file } : { ok: false, errorCode: errorCode ?? 'internal' } }, rpc),
  };
}

export async function runOnlineRenderJob(deps: OnlineRunDeps): Promise<OnlineRunResult> {
  const { env } = deps;
  if (!env.on) return { status: 'switched_off' };
  if (!env.printTokenSecret || env.printTokenSecret.length < MIN_PRINT_TOKEN_SECRET_LENGTH) return { status: 'not_configured', code: 'print_token_secret_missing' };
  if (!env.siteUrl) return { status: 'not_configured', code: 'site_url_missing' };
  const origin = new URL(env.siteUrl).origin;
  const secret = env.printTokenSecret;
  const worker = `online-${randomUUID().slice(0, 8)}`;

  const started = deps.now();
  let browser: Awaited<ReturnType<OnlineRunDeps['launch']>>;
  try {
    browser = await deps.launch();
  } catch {
    return { status: 'browser_unavailable' };
  }
  const launchMs = deps.now() - started;
  try {
    const renderer = createUrlPdfRenderer({ browser, origin, now: deps.now });
    const day = deps.today();
    let current: { url: string; jobId: string; checked: PrintPageCheck } | null = null;
    // Review E10-6: the token goes in a header (never the URL), fresh for each page load.
    const tokenHeader = (jobId: string) => ({ [PRINT_TOKEN_HEADER]: signPrintToken({ jobId, worker, day }, secret, deps.now()) });
    const jobs = deps.supabase(worker);
    const outcome = await processOneJob({
      worker,
      ...jobs,
      objectPathFor: (job) => job.objectPath,
      today: () => day,
      renderHtml: async (job) => {
        const url = `${origin}/print/itinerary/${job.jobId}`;
        const checked = await renderer.check(url, tokenHeader(job.jobId));
        current = { url, jobId: job.jobId, checked };
        // Review E10-2: the scans cover everything that prints, not only the template.
        return {
          html: checked.markup,
          safetyHits: scanText(checked.bodyText),
          placeholders: checked.placeholders,
          pageIssues: checked.strayText ? ['page_chrome'] : [],
        };
      },
      renderPdf: async () => {
        if (!current) throw new Error('print page not checked');
        return renderer.print(current.url, current.checked, tokenHeader(current.jobId));
      },
    });
    return { status: 'ran', outcome, launchMs };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * The worker route: GET from Vercel Cron (Bearer CRON_SECRET), POST for a
 * manual run (Bearer RENDER_WORKER_SECRET). Secrets shorter than 32
 * characters count as not configured. Switched off = 404 after auth.
 */
export async function handleOnlineRenderRequest(
  request: Request,
  trigger: 'cron' | 'manual',
  deps: OnlineRunDeps,
): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const secret = trigger === 'cron' ? deps.env.cronSecret : deps.env.workerSecret;
  if (!secret || secret.length < MIN_WORKER_SECRET_LENGTH) return json(503, { status: 'not_configured', code: 'worker_secret_missing' });
  if (!checkBearer(request.headers.get('authorization'), secret)) return json(401, { status: 'unauthorized' });
  // Accounts phase 2 (contract 6.8): itinerary first, then customer documents; one job per call.
  let result: OnlineRunResult | OnlineCustomerRunResult = await runOnlineRenderJob(deps);
  if (result.status === 'ran' && result.outcome.outcome === 'idle' && deps.customerSupabase) {
    result = await runOnlineCustomerRenderJob({ ...deps, supabase: deps.customerSupabase });
  }
  if (result.status === 'switched_off') return json(404, result);
  if (result.status === 'not_configured' || result.status === 'browser_unavailable') return json(503, result);
  return json(200, result);
}

export function productionOnlineDeps(): OnlineRunDeps {
  return {
    env: getOnlineRenderEnv(),
    launch: launchChromium,
    supabase: serviceRoleJobDeps,
    customerSupabase: serviceRoleCustomerJobDeps,
    now: () => Date.now(),
    today: () => istDate(),
  };
}

// ===========================================================================
// Accounts phase 2 (contract 6.8, LD2): the customer document queue.
// ===========================================================================

export type OnlineCustomerRunResult =
  | { status: 'switched_off' }
  | { status: 'not_configured'; code: 'print_token_secret_missing' | 'site_url_missing' }
  | { status: 'browser_unavailable' }
  | { status: 'ran'; outcome: CustomerJobOutcome; launchMs: number };

export interface OnlineCustomerRunDeps {
  env: OnlineRenderEnv;
  launch(): Promise<UrlPdfBrowser & { close(): Promise<void> }>;
  supabase(worker: string): Pick<CustomerWorkerDeps, 'claim' | 'input' | 'complete' | 'upload'>;
  now(): number;
  today(): string;
}

export function serviceRoleCustomerJobDeps(worker: string): Pick<CustomerWorkerDeps, 'claim' | 'input' | 'complete' | 'upload'> {
  const admin = createSupabaseAdminClient();
  const rpc = admin as unknown as CustomerRenderRpc;
  return {
    claim: () => customerRenderClaim(rpc, worker, ONLINE_LEASE_SECONDS),
    input: (jobId) => customerRenderInput(rpc, jobId, worker),
    upload: async (objectPath, pdf) => {
      const { error } = await admin.storage.from(RENDERED_BUCKET).upload(objectPath, pdf, { contentType: 'application/pdf', upsert: false });
      if (error) throw new Error('upload failed');
    },
    complete: (jobId, outcome) => customerRenderComplete(rpc, jobId, worker, outcome),
  };
}

/**
 * One queued customer document job through the in-app print page
 * /print/customer-document/<job> (token in the request header). Off unless
 * PDF_RENDER_ONLINE is "on" (switching it on is a separate APPROVE). The
 * release action schedules one run with after(); the worker route drains the
 * queue one job per call after the itinerary queue.
 */
export async function runOnlineCustomerRenderJob(deps: OnlineCustomerRunDeps = productionOnlineCustomerDeps()): Promise<OnlineCustomerRunResult> {
  const { env } = deps;
  if (!env.on) return { status: 'switched_off' };
  if (!env.printTokenSecret || env.printTokenSecret.length < MIN_PRINT_TOKEN_SECRET_LENGTH) return { status: 'not_configured', code: 'print_token_secret_missing' };
  if (!env.siteUrl) return { status: 'not_configured', code: 'site_url_missing' };
  const origin = new URL(env.siteUrl).origin;
  const secret = env.printTokenSecret;
  const worker = `online-${randomUUID().slice(0, 8)}`;
  const jobs = deps.supabase(worker);
  // Nothing queued: no browser launch.
  const first = await jobs.claim();
  if (!first) return { status: 'ran', outcome: { outcome: 'idle' }, launchMs: 0 };
  const started = deps.now();
  let browser: Awaited<ReturnType<OnlineCustomerRunDeps['launch']>>;
  try {
    browser = await deps.launch();
  } catch {
    // The claimed job's lease runs out and the next run takes it again.
    return { status: 'browser_unavailable' };
  }
  const launchMs = deps.now() - started;
  try {
    const renderer = createUrlPdfRenderer({ browser, origin, now: deps.now });
    const day = deps.today();
    let current: { url: string; jobId: string; checked: PrintPageCheck } | null = null;
    const tokenHeader = (jobId: string) => ({ [PRINT_TOKEN_HEADER]: signPrintToken({ jobId, worker, day }, secret, deps.now()) });
    let claimed = false;
    const outcome = await processOneCustomerJob({
      worker,
      ...jobs,
      claim: async () => {
        if (claimed) return null;
        claimed = true;
        return first;
      },
      renderHtml: async (job) => {
        const url = `${origin}/print/customer-document/${job.jobId}`;
        const checked = await renderer.check(url, tokenHeader(job.jobId));
        current = { url, jobId: job.jobId, checked };
        return {
          html: checked.markup,
          safetyHits: scanText(checked.bodyText),
          placeholders: checked.placeholders,
          pageIssues: checked.strayText ? ['page_chrome'] : [],
        };
      },
      renderPdf: async () => {
        if (!current) throw new Error('print page not checked');
        return renderer.print(current.url, current.checked, tokenHeader(current.jobId));
      },
    });
    return { status: 'ran', outcome, launchMs };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function productionOnlineCustomerDeps(): OnlineCustomerRunDeps {
  return {
    env: getOnlineRenderEnv(),
    launch: launchChromium,
    supabase: serviceRoleCustomerJobDeps,
    now: () => Date.now(),
    today: () => istDate(),
  };
}

// ===========================================================================
// Accounts phase 3 (contract 5.2 step 4, 6.4): one queued PDF per timer run.
// ===========================================================================

/**
 * The timer's render step: renders at most one queued job (itinerary first,
 * then a customer document, the worker route's order). Returns null while the
 * online PDF maker is off (PDF_RENDER_ONLINE is not "on"; the timer marks the
 * step skipped), otherwise counts only (no ids, names or amounts). The timer
 * route gives the step its own time budget; the claimed job's lease covers a
 * run that is cut short.
 */
export async function renderOneQueuedJob(deps: OnlineRunDeps = productionOnlineDeps()): Promise<Record<string, number> | null> {
  if (!deps.env.on) return null;
  let result: OnlineRunResult | OnlineCustomerRunResult = await runOnlineRenderJob(deps);
  if (result.status === 'ran' && result.outcome.outcome === 'idle' && deps.customerSupabase) {
    result = await runOnlineCustomerRenderJob({ ...deps, supabase: deps.customerSupabase });
  }
  if (result.status !== 'ran') {
    return { rendered: 0, idle: 0, failed: 1, notConfigured: result.status === 'not_configured' ? 1 : 0 };
  }
  const idle = result.outcome.outcome === 'idle';
  return { rendered: idle ? 0 : 1, idle: idle ? 1 : 0, failed: 0, notConfigured: 0 };
}
