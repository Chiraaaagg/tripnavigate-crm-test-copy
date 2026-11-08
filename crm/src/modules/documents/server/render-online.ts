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
import { processOneJob, type JobOutcome, type WorkerDeps } from '../render/worker-core';
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
  const result = await runOnlineRenderJob(deps);
  if (result.status === 'switched_off') return json(404, result);
  if (result.status === 'not_configured' || result.status === 'browser_unavailable') return json(503, result);
  return json(200, result);
}

export function productionOnlineDeps(): OnlineRunDeps {
  return {
    env: getOnlineRenderEnv(),
    launch: launchChromium,
    supabase: serviceRoleJobDeps,
    now: () => Date.now(),
    today: () => istDate(),
  };
}
